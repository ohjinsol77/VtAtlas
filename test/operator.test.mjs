import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const mutationRequests = [];
const inventory = {
  clusters: [
    { id: "local", name: "Local Vitess" },
    { id: "remote-a", name: "Remote A" },
  ],
  keyspaces: [
    {
      cluster: { id: "local" },
      keyspace: { name: "identity" },
      shards: { "0": {} },
    },
    {
      cluster: { id: "local" },
      keyspace: { name: "commerce" },
      shards: { "-80": {}, "80-": {} },
    },
    {
      cluster: { id: "remote-a" },
      keyspace: { name: "catalog" },
      shards: { "-55": {}, "55-aa": {}, "aa-": {} },
    },
  ],
  tablets: [
    {
      cluster: { id: "local" },
      tablet: {
        alias: { cell: "zone1", uid: 100 },
        keyspace: "identity",
        shard: "0",
      },
    },
    {
      cluster: { id: "local" },
      tablet: {
        alias: { cell: "zone1", uid: 200 },
        keyspace: "commerce",
        shard: "-80",
      },
    },
    {
      cluster: { id: "remote-a" },
      tablet: {
        alias: { cell: "zone2", uid: 300 },
        keyspace: "catalog",
        shard: "-55",
      },
    },
  ],
};

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const upstream = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/clusters") {
    json(response, 200, { ok: true, result: { clusters: inventory.clusters } });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/keyspaces") {
    json(response, 200, { ok: true, result: { keyspaces: inventory.keyspaces } });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/tablets") {
    json(response, 200, { ok: true, result: { tablets: inventory.tablets } });
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  mutationRequests.push({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  json(response, 200, {
    ok: true,
    result: { accepted: true, method: request.method, path: url.pathname },
  });
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const upstreamBase = await listen(upstream);
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "vtatlas-operator-"));
const auditFile = path.join(temporaryDir, "audit.jsonl");
process.env.VTO_VTADMIN_API = upstreamBase;
process.env.VTO_AUDIT_FILE = auditFile;
process.env.VTO_AUTH_MODE = "deferred";
const { createOperatorServer } = await import(
  `../operator/server.mjs?test=${Date.now()}`
);
const operator = createOperatorServer();
const operatorBase = await listen(operator);

after(async () => {
  await close(operator);
  await close(upstream);
});

async function call(pathname, { method = "GET", intent, body, cookie } = {}) {
  const response = await fetch(`${operatorBase}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(intent ? { "X-VtAtlas-DBA-Intent": intent } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return {
    status: response.status,
    payload,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

async function openSession() {
  const result = await call("/session", {
    method: "POST",
    intent: "enable-dba-mode",
    body: { acknowledgement: "DBA MODE" },
  });
  assert.equal(result.status, 201);
  assert.match(result.cookie, /^vtatlas_dba_session=/);
  return result.cookie;
}

async function prepare(cookie, actionId, fields, body) {
  return call("/prepare", {
    method: "POST",
    intent: "prepare-operation",
    cookie,
    body: { actionId, fields, ...(body === undefined ? {} : { body }) },
  });
}

test("operator publishes a full DBA catalog but blocks operations without a session", async () => {
  const catalog = await call("/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.payload.operations.length, 41);
  assert.equal(catalog.payload.authenticationImplemented, false);
  assert.ok(
    catalog.payload.operations.some(
      (item) => item.id === "emergency_failover" && item.severity === "critical",
    ),
  );

  const blocked = await prepare(
    "",
    "validate_cluster",
    { cluster: "local" },
    { ping_tablets: true },
  );
  assert.equal(blocked.status, 401);
  assert.match(blocked.payload.error, /session/);
});

test("DBA session requires explicit local acknowledgement", async () => {
  const rejected = await call("/session", {
    method: "POST",
    intent: "enable-dba-mode",
    body: { acknowledgement: "yes" },
  });
  assert.equal(rejected.status, 400);
  const cookie = await openSession();
  const session = await call("/session", { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.payload.active, true);
  assert.equal(session.payload.actor.authenticated, false);
  assert.deepEqual(session.payload.actor.roles, ["dba"]);
});

test("preflight recognizes unsharded, local sharded, and remote sharded targets", async () => {
  const cookie = await openSession();
  const cases = [
    { cluster: "local", keyspace: "identity", shard: "0" },
    { cluster: "local", keyspace: "commerce", shard: "-80" },
    { cluster: "remote-a", keyspace: "catalog", shard: "-55" },
  ];
  for (const fields of cases) {
    const result = await prepare(cookie, "validate_shard", fields, {
      ping_tablets: true,
    });
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal(result.payload.target.cluster.id, fields.cluster);
    assert.equal(result.payload.target.keyspace, fields.keyspace);
    assert.equal(result.payload.target.shard, fields.shard);
    assert.equal(
      result.payload.confirmationPhrase,
      `EXECUTE validate_shard ${fields.cluster}/${fields.keyspace}/${fields.shard}`,
    );
  }
});

test("preflight rejects missing cluster, keyspace, shard, and tablet targets", async () => {
  const cookie = await openSession();
  const cases = [
    ["validate_cluster", { cluster: "missing" }, /Cluster/],
    [
      "validate_keyspace",
      { cluster: "local", keyspace: "missing" },
      /Keyspace/,
    ],
    [
      "validate_shard",
      { cluster: "local", keyspace: "commerce", shard: "missing" },
      /Shard/,
    ],
    [
      "refresh_state",
      { cluster: "local", tablet: "zone1-0000000999" },
      /Tablet/,
    ],
  ];
  for (const [actionId, fields, expected] of cases) {
    const result = await prepare(cookie, actionId, fields, {});
    assert.equal(result.status, 404);
    assert.match(result.payload.error, expected);
  }
});

test("new keyspace name is part of the immutable body, preflight target, and approval phrase", async () => {
  const cookie = await openSession();
  const created = await prepare(
    cookie,
    "create_keyspace",
    { cluster: "remote-a", newKeyspace: "new_catalog" },
    {
      force: false,
      allow_empty_v_schema: true,
      durability_policy: "none",
    },
  );
  assert.equal(created.status, 201);
  assert.equal(created.payload.target.keyspace, "new_catalog");
  assert.equal(
    created.payload.confirmationPhrase,
    "EXECUTE create_keyspace remote-a/new_catalog",
  );

  const conflict = await prepare(
    cookie,
    "create_keyspace",
    { cluster: "remote-a", newKeyspace: "catalog" },
    { force: false },
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.payload.error, /이미 존재/);
});

test("approval binds the exact method/path, requires a phrase, and cannot be replayed", async () => {
  const cookie = await openSession();
  const prepared = await prepare(
    cookie,
    "validate_shard",
    { cluster: "remote-a", keyspace: "catalog", shard: "aa-" },
    { ping_tablets: false },
  );
  assert.equal(prepared.status, 201);
  assert.deepEqual(prepared.payload.upstream, {
    method: "PUT",
    path: "/api/shard/remote-a/catalog/aa-/validate",
  });

  const executed = await call("/execute", {
    method: "POST",
    intent: "execute-operation",
    cookie,
    body: {
      approvalToken: prepared.payload.approvalToken,
      confirmation: prepared.payload.confirmationPhrase,
    },
  });
  assert.equal(executed.status, 200);
  assert.equal(executed.payload.result.result.accepted, true);
  assert.deepEqual(mutationRequests.at(-1), {
    method: "PUT",
    path: "/api/shard/remote-a/catalog/aa-/validate",
    body: '{"ping_tablets":false}',
  });

  const replay = await call("/execute", {
    method: "POST",
    intent: "execute-operation",
    cookie,
    body: {
      approvalToken: prepared.payload.approvalToken,
      confirmation: prepared.payload.confirmationPhrase,
    },
  });
  assert.equal(replay.status, 409);
});

test("destructive and GET-based mutating routes are prepared but only hit the mock after approval", async () => {
  const cookie = await openSession();
  const before = mutationRequests.length;
  const destructive = await prepare(cookie, "delete_keyspace", {
    cluster: "remote-a",
    keyspace: "catalog",
  });
  assert.equal(destructive.status, 201);
  assert.equal(mutationRequests.length, before);
  assert.equal(destructive.payload.operation.severity, "critical");

  const workflow = await prepare(cookie, "start_workflow", {
    cluster: "local",
    keyspace: "commerce",
    workflow: "move_tables_01",
  });
  assert.equal(workflow.status, 201);
  assert.equal(workflow.payload.upstream.method, "GET");
  assert.equal(mutationRequests.length, before);
});

test("audit records sessions, prepared operations, and executed results", async () => {
  const cookie = await openSession();
  const result = await call("/audit", { cookie });
  assert.equal(result.status, 200);
  assert.ok(result.payload.entries.some((entry) => entry.type === "session_enabled"));
  assert.ok(result.payload.entries.some((entry) => entry.type === "operation_prepared"));
  assert.ok(result.payload.entries.some((entry) => entry.type === "operation_finished"));

  const raw = await readFile(auditFile, "utf8");
  assert.doesNotMatch(raw, /do-not-leak|also-secret/);
  for (const line of raw.trim().split(/\r?\n/)) assert.doesNotThrow(() => JSON.parse(line));
});
