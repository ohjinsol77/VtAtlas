import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOperationRequest,
  confirmationPhrase,
  DBA_OPERATIONS,
  getOperation,
  READ_OPERATIONS,
} from "../lib/vtadmin-operations.mjs";

test("catalog covers every registered VTAdmin v23 HTTP route without duplicate IDs", () => {
  const all = [...READ_OPERATIONS, ...DBA_OPERATIONS];
  assert.equal(all.length, 76);
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  assert.equal(READ_OPERATIONS.every((item) => item.access === "viewer"), true);
  assert.equal(DBA_OPERATIONS.every((item) => item.access === "dba"), true);
  assert.ok(READ_OPERATIONS.some((item) => item.id === "whoami"));
});

test("every Viewer and DBA catalog entry builds a bounded /api request", () => {
  const fields = {
    cluster: "local",
    keyspace: "identity",
    newKeyspace: "new_identity",
    shard: "0",
    tablet: "zone1-0000000100",
    table: "customer",
    cell: "zone1",
    workflow: "move_tables_01",
    dtid: "dtid_01",
    uuid: "00000000-0000-0000-0000-000000000001",
    sql: "select 1",
    topologyPath: "/",
  };
  for (const operation of [...READ_OPERATIONS, ...DBA_OPERATIONS]) {
    const request = buildOperationRequest(operation, { fields });
    assert.match(request.path, /^\/api\//, operation.id);
    assert.doesNotMatch(request.path, /[{}]/, operation.id);
    assert.ok(["GET", "POST", "PUT", "DELETE"].includes(request.method));
    if (request.body) assert.doesNotThrow(() => JSON.parse(request.body));
  }
});

test("viewer catalog cannot resolve state-changing operations", () => {
  for (const id of [
    "create_keyspace",
    "planned_failover",
    "stop_replication",
    "apply_schema",
    "conclude_transaction",
    "start_workflow",
  ]) {
    assert.throws(() => getOperation(id, "viewer"), /unsupported viewer operation/);
  }
});

test("tablet request uses an encoded path and scoped cluster query", () => {
  const request = buildOperationRequest(getOperation("tablet_health", "viewer"), {
    fields: { cluster: "remote-a", tablet: "zone-a-0000000101" },
  });
  assert.deepEqual(request, {
    method: "GET",
    path: "/api/tablet/zone-a-0000000101/healthcheck?cluster_id=remote-a",
    body: undefined,
    headers: {},
  });
});

test("create and delete shard requests match VTAdmin HTTP contracts", () => {
  const create = buildOperationRequest(getOperation("create_shard", "dba"), {
    fields: { cluster: "local", keyspace: "commerce", shard: "-80" },
  });
  assert.equal(create.method, "POST");
  assert.equal(create.path, "/api/shards/local");
  assert.deepEqual(JSON.parse(create.body), {
    force: false,
    include_parent: false,
    keyspace: "commerce",
    shard_name: "-80",
  });

  const remove = buildOperationRequest(getOperation("delete_shard", "dba"), {
    fields: { cluster: "remote-a", keyspace: "catalog", shard: "55-aa" },
  });
  assert.equal(remove.method, "DELETE");
  assert.equal(
    remove.path,
    "/api/shards/remote-a?recursive=false&even_if_serving=false&keyspace_shard=catalog%2F55-aa",
  );
});

test("create keyspace binds its name from a validated field into the body", () => {
  const request = buildOperationRequest(getOperation("create_keyspace", "dba"), {
    fields: { cluster: "remote-a", newKeyspace: "new_catalog" },
  });
  assert.equal(request.path, "/api/keyspace/remote-a");
  assert.deepEqual(JSON.parse(request.body), {
    force: false,
    allow_empty_v_schema: true,
    durability_policy: "none",
    name: "new_catalog",
  });
});

test("query arrays and explicit body overrides are accepted but objects in query are rejected", () => {
  const request = buildOperationRequest(getOperation("reload_schemas", "dba"), {
    fields: { cluster: "local" },
    query: {
      keyspace: ["identity", "commerce"],
      tablet: ["zone1-0000000100"],
      concurrency: 2,
    },
  });
  const url = new URL(request.path, "http://localhost");
  assert.deepEqual(url.searchParams.getAll("keyspace"), ["identity", "commerce"]);
  assert.deepEqual(url.searchParams.getAll("tablet"), ["zone1-0000000100"]);
  assert.equal(url.searchParams.get("cluster_id"), "local");
  assert.throws(
    () =>
      buildOperationRequest(getOperation("reload_schemas", "dba"), {
        fields: { cluster: "local" },
        query: { unsafe: { nested: true } },
      }),
    /must be scalar/,
  );
});

test("field and response-path safety reject traversal, control characters, and invalid aliases", () => {
  assert.throws(
    () =>
      buildOperationRequest(getOperation("keyspace", "viewer"), {
        fields: { cluster: "../other", keyspace: "identity" },
      }),
    /unsupported characters/,
  );
  assert.throws(
    () =>
      buildOperationRequest(getOperation("tablet", "viewer"), {
        fields: { cluster: "local", tablet: "zone1/../../etc" },
      }),
    /cell-uid format/,
  );
  assert.throws(
    () =>
      buildOperationRequest(getOperation("vexplain", "viewer"), {
        fields: {
          cluster: "local",
          keyspace: "identity",
          sql: "select 1\u0000",
        },
      }),
    /required/,
  );
});

test("operation bodies are size bounded", () => {
  assert.throws(
    () =>
      buildOperationRequest(getOperation("apply_schema", "dba"), {
        fields: { cluster: "local", keyspace: "identity" },
        body: { sql: "x".repeat(140 * 1024) },
      }),
    /too large/,
  );
});

test("confirmation phrase binds the action and concrete target", () => {
  const item = getOperation("emergency_failover", "dba");
  assert.equal(
    confirmationPhrase(item, {
      fields: { cluster: "remote-a", keyspace: "catalog", shard: "aa-" },
    }),
    "EXECUTE emergency_failover remote-a/catalog/aa-",
  );
});
