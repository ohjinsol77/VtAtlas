#!/usr/bin/env node

const baseUrl = new URL(
  process.env.VTATLAS_URL ?? "http://127.0.0.1:17888",
);
const executeValidations = process.argv.includes("--execute-validations");
const localClusterId = process.env.VTATLAS_LOCAL_CLUSTER_ID ?? "local";

if (!["127.0.0.1", "::1", "localhost"].includes(baseUrl.hostname)) {
  throw new Error("live operator probe only accepts a loopback VtAtlas URL");
}

let cookie = "";

async function request(pathname, options = {}, expectedStatuses = [200]) {
  const response = await fetch(new URL(pathname, baseUrl), {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${options.method ?? "GET"} ${pathname}: HTTP ${response.status} ${body.error ?? ""}`,
    );
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, body };
}

async function readOperation(operationId, payload = {}) {
  const result = await request("/api/admin/read", {
    method: "POST",
    headers: { "X-VtAtlas-Admin-Intent": "read-vtadmin" },
    body: JSON.stringify({ operationId, ...payload }),
  });
  return result.body.result?.result ?? result.body.result ?? {};
}

function keyspaceName(item) {
  return item?.keyspace?.name ?? item?.name ?? "";
}

function keyspaceCluster(item) {
  return item?.cluster?.id ?? "";
}

function shards(item) {
  return Object.keys(item?.shards ?? {});
}

function snapshot(keyspaces, tablets) {
  return JSON.stringify({
    keyspaces: keyspaces
      .map((item) => ({
        cluster: keyspaceCluster(item),
        keyspace: keyspaceName(item),
        shards: shards(item).sort(),
      }))
      .sort((a, b) =>
        `${a.cluster}/${a.keyspace}`.localeCompare(`${b.cluster}/${b.keyspace}`),
      ),
    tablets: tablets
      .map((item) => {
        const alias = item?.tablet?.alias;
        return {
          cluster: item?.cluster?.id,
          keyspace: item?.tablet?.keyspace,
          shard: item?.tablet?.shard,
          alias:
            typeof alias === "string"
              ? alias
              : `${alias?.cell}-${String(alias?.uid ?? "").padStart(10, "0")}`,
          type: item?.tablet?.type,
        };
      })
      .sort((a, b) => a.alias.localeCompare(b.alias)),
  });
}

function targetClasses(keyspaces) {
  const unsharded = keyspaces.find(
    (item) =>
      keyspaceCluster(item) === localClusterId &&
      shards(item).length === 1 &&
      shards(item)[0] === "0",
  );
  const localSharded = keyspaces.find(
    (item) =>
      keyspaceCluster(item) === localClusterId &&
      !(shards(item).length === 1 && shards(item)[0] === "0"),
  );
  const remoteSharded = keyspaces.find(
    (item) =>
      keyspaceCluster(item) !== localClusterId &&
      !(shards(item).length === 1 && shards(item)[0] === "0"),
  );
  if (!unsharded || !localSharded || !remoteSharded) {
    throw new Error(
      "unsharded, local-sharded, and remote-sharded targets are all required",
    );
  }
  return { unsharded, localSharded, remoteSharded };
}

async function prepareValidation(target, shard) {
  const fields = {
    cluster: keyspaceCluster(target),
    keyspace: keyspaceName(target),
    shard,
  };
  const prepared = await request("/api/operator/prepare", {
    method: "POST",
    headers: { "X-VtAtlas-DBA-Intent": "prepare-operation" },
    body: JSON.stringify({
      actionId: "validate_shard",
      fields,
      body: { ping_tablets: false },
    }),
  }, [201]);
  if (
    prepared.body.target.cluster.id !== fields.cluster ||
    prepared.body.target.keyspace !== fields.keyspace ||
    prepared.body.target.shard !== fields.shard
  ) {
    throw new Error(`operator preflight target mismatch: ${JSON.stringify(fields)}`);
  }
  return prepared.body;
}

async function executePrepared(prepared) {
  return request("/api/operator/execute", {
    method: "POST",
    headers: { "X-VtAtlas-DBA-Intent": "execute-operation" },
    body: JSON.stringify({
      approvalToken: prepared.approvalToken,
      confirmation: prepared.confirmationPhrase,
    }),
  });
}

const report = {
  at: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  executeValidations,
  checks: [],
};

const configuration = await request("/api/configuration");
if (
  !configuration.body.topologyReadOnly ||
  !configuration.body.vtadminViewerEnabled ||
  !configuration.body.operatorApiEnabled
) {
  throw new Error("VtAtlas viewer/operator configuration is incomplete");
}
report.checks.push("configuration");

const viewerCatalog = await request("/api/admin/catalog");
const operatorCatalog = await request("/api/operator/catalog");
if (
  viewerCatalog.body.operations.length !== 35 ||
  operatorCatalog.body.operations.length !== 41
) {
  throw new Error("VTAdmin operation catalog count mismatch");
}
report.catalog = {
  viewer: viewerCatalog.body.operations.length,
  dba: operatorCatalog.body.operations.length,
};
report.checks.push("catalog");

report.viewerSweep = [];
for (const operation of viewerCatalog.body.operations.filter(
  (item) => item.fields.length === 0,
)) {
  const started = performance.now();
  const result = await readOperation(operation.id);
  report.viewerSweep.push({
    operation: operation.id,
    ok: true,
    durationMs: Math.round(performance.now() - started),
    resultKeys:
      result && typeof result === "object" ? Object.keys(result).slice(0, 8) : [],
  });
}
report.checks.push("fieldless-viewer-operations");

const [clustersResult, keyspacesResult, tabletsResult] = await Promise.all([
  readOperation("clusters"),
  readOperation("keyspaces"),
  readOperation("tablets"),
]);
const clusters = clustersResult.clusters ?? [];
const keyspaces = keyspacesResult.keyspaces ?? [];
const tablets = tabletsResult.tablets ?? [];
const before = snapshot(keyspaces, tablets);
const classes = targetClasses(keyspaces);
report.inventory = {
  clusters: clusters.map((item) => item.id),
  keyspaces: keyspaces.map(
    (item) => `${keyspaceCluster(item)}/${keyspaceName(item)}`,
  ),
  tablets: tablets.length,
};
report.checks.push("viewer-inventory");

const noSession = await request(
  "/api/operator/prepare",
  {
    method: "POST",
    headers: { "X-VtAtlas-DBA-Intent": "prepare-operation" },
    body: JSON.stringify({
      actionId: "validate_cluster",
      fields: { cluster: localClusterId },
    }),
  },
  [401],
);
if (!String(noSession.body.error).includes("session")) {
  throw new Error("operator did not reject a request without a DBA session");
}
report.checks.push("session-required");

await request(
  "/api/operator/session",
  {
    method: "POST",
    headers: { "X-VtAtlas-DBA-Intent": "enable-dba-mode" },
    body: JSON.stringify({ acknowledgement: "not accepted" }),
  },
  [400],
);
const session = await request(
  "/api/operator/session",
  {
    method: "POST",
    headers: { "X-VtAtlas-DBA-Intent": "enable-dba-mode" },
    body: JSON.stringify({ acknowledgement: "DBA MODE" }),
  },
  [201],
);
if (!session.body.active || !cookie) throw new Error("DBA session was not issued");
report.checks.push("session-acknowledgement");

const targets = [
  ["unsharded", classes.unsharded],
  ["local-sharded", classes.localSharded],
  ["remote-sharded", classes.remoteSharded],
];
report.validations = [];
for (const [kind, target] of targets) {
  for (const shard of shards(target)) {
    const prepared = await prepareValidation(target, shard);
    const row = {
      kind,
      target: `${keyspaceCluster(target)}/${keyspaceName(target)}/${shard}`,
      prepared: true,
      executed: false,
    };
    if (executeValidations) {
      const executed = await executePrepared(prepared);
      row.executed = true;
      row.auditId = executed.body.auditId;
      row.upstreamStatus = executed.body.upstreamStatus;
    }
    report.validations.push(row);
  }
}
report.checks.push(
  executeValidations ? "safe-validations-executed" : "safe-validations-prepared",
);

const [keyspacesAfterResult, tabletsAfterResult] = await Promise.all([
  readOperation("keyspaces"),
  readOperation("tablets"),
]);
const afterSnapshot = snapshot(
  keyspacesAfterResult.keyspaces ?? [],
  tabletsAfterResult.tablets ?? [],
);
if (before !== afterSnapshot) {
  throw new Error("topology inventory changed during the validation probe");
}
report.checks.push("topology-unchanged");

const audit = await request("/api/operator/audit");
if (!audit.body.entries.some((entry) => entry.type === "operation_prepared")) {
  throw new Error("operator audit did not record prepared operations");
}
if (
  executeValidations &&
  !audit.body.entries.some((entry) => entry.type === "operation_finished")
) {
  throw new Error("operator audit did not record executed operations");
}
report.auditEntries = audit.body.entries.length;
report.checks.push("audit");

await request("/api/operator/session", {
  method: "DELETE",
  headers: { "X-VtAtlas-DBA-Intent": "disable-dba-mode" },
  body: "{}",
});
report.checks.push("session-closed");

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
