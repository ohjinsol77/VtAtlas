import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRbac = await readFile(
  new URL("../vtadmin/rbac-readonly.yaml", import.meta.url),
  "utf8",
);
const dbaRbac = await readFile(
  new URL("../vtadmin/rbac-dba.yaml", import.meta.url),
  "utf8",
);
const vtadminUnit = await readFile(
  new URL("../deploy/vtatlas-vtadmin-operator.service", import.meta.url),
  "utf8",
);
const operatorUnit = await readFile(
  new URL("../deploy/vtatlas-operator.service", import.meta.url),
  "utf8",
);

test("read-only VTAdmin RBAC has no write action", () => {
  assert.match(readRbac, /actions:\s*\["get", "ping"\]/);
  assert.doesNotMatch(
    readRbac,
    /\b(create|delete|put|reload|cancel|retry|complete)\b/,
  );
});

test("DBA RBAC names specific write actions and does not grant wildcard actions", () => {
  assert.doesNotMatch(dbaRbac, /actions:\s*\["\*"\]/);
  for (const action of [
    "emergency_failover_shard",
    "planned_failover_shard",
    "tablet_externally_promoted",
    "manage_tablet_replication",
    "manage_tablet_writability",
    "refresh_tablet_replication_source",
    "cleanup_schema_migration",
    "complete_schema_migration",
    "launch_schema_migration",
  ]) {
    assert.match(dbaRbac, new RegExp(`"${action}"`));
  }
});

test("write-enabled services use separate loopback ports and a private audit file", () => {
  assert.match(vtadminUnit, /VTA_API_BIND=127\.0\.0\.1:14202/);
  assert.match(vtadminUnit, /VTA_RBAC_CONFIG=.*rbac-dba\.yaml/);
  assert.match(operatorUnit, /VTO_HOST=127\.0\.0\.1/);
  assert.match(operatorUnit, /VTO_VTADMIN_API=http:\/\/127\.0\.0\.1:14202/);
  assert.match(operatorUnit, /VTO_AUDIT_FILE=.*operator-audit\.jsonl/);
  assert.match(operatorUnit, /UMask=0077/);
});
