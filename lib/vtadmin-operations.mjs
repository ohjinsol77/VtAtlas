const FIELD_RE = /^[A-Za-z0-9_.:@+-]{1,256}$/;
const TABLET_RE = /^[A-Za-z0-9_.:-]+-\d{1,10}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function operation({
  id,
  label,
  category,
  access,
  method,
  path,
  fields = [],
  severity = "info",
  description = "",
  defaultBody,
  defaultQuery,
  queryFromFields,
  bodyFromFields,
  combineKeyspaceShard = false,
}) {
  return Object.freeze({
    id,
    label,
    category,
    access,
    method,
    path,
    fields,
    severity,
    description,
    defaultBody,
    defaultQuery,
    queryFromFields,
    bodyFromFields,
    combineKeyspaceShard,
  });
}

export const READ_OPERATIONS = Object.freeze([
  operation({ id: "clusters", label: "Cluster", category: "inventory", access: "viewer", method: "GET", path: "/api/clusters", description: "등록된 Cluster 목록" }),
  operation({ id: "keyspaces", label: "Keyspace", category: "inventory", access: "viewer", method: "GET", path: "/api/keyspaces", description: "Keyspace와 Shard 구조" }),
  operation({ id: "tablets", label: "Tablet", category: "inventory", access: "viewer", method: "GET", path: "/api/tablets", description: "Tablet 상태와 역할" }),
  operation({ id: "schemas", label: "Schema", category: "schema", access: "viewer", method: "GET", path: "/api/schemas", description: "모든 Cluster의 Schema" }),
  operation({ id: "vschemas", label: "VSchema", category: "schema", access: "viewer", method: "GET", path: "/api/vschemas", description: "VSchema와 VIndex" }),
  operation({ id: "workflows", label: "Workflow", category: "workflow", access: "viewer", method: "GET", path: "/api/workflows", description: "VReplication Workflow" }),
  operation({ id: "gates", label: "VTGate", category: "inventory", access: "viewer", method: "GET", path: "/api/gates", description: "VTGate 인스턴스" }),
  operation({ id: "vtctlds", label: "vtctld", category: "inventory", access: "viewer", method: "GET", path: "/api/vtctlds", description: "vtctld 인스턴스" }),
  operation({ id: "backups", label: "Backup", category: "operations", access: "viewer", method: "GET", path: "/api/backups", description: "Backup 목록과 상태" }),
  operation({ id: "cells", label: "Cell", category: "topology", access: "viewer", method: "GET", path: "/api/cells", description: "Cell 정보" }),
  operation({ id: "cell_aliases", label: "Cell Alias", category: "topology", access: "viewer", method: "GET", path: "/api/cells_aliases", description: "Cell Alias 정보" }),
  operation({ id: "srv_keyspaces", label: "Serving Keyspace", category: "topology", access: "viewer", method: "GET", path: "/api/srvkeyspaces", description: "Serving Graph의 Keyspace" }),
  operation({ id: "srv_vschemas", label: "Serving VSchema", category: "topology", access: "viewer", method: "GET", path: "/api/srvvschemas", description: "Cell별 Serving VSchema" }),
  operation({ id: "shard_positions", label: "복제 위치", category: "replication", access: "viewer", method: "GET", path: "/api/shard_replication_positions", description: "Shard별 복제 위치" }),
  operation({ id: "keyspace", label: "Keyspace 상세", category: "inventory", access: "viewer", method: "GET", path: "/api/keyspace/{cluster}/{keyspace}", fields: ["cluster", "keyspace"] }),
  operation({ id: "schema", label: "Table Schema", category: "schema", access: "viewer", method: "GET", path: "/api/schema/{cluster}/{keyspace}/{table}", fields: ["cluster", "keyspace", "table"] }),
  operation({ id: "find_schema", label: "Schema 검색", category: "schema", access: "viewer", method: "GET", path: "/api/schema/{table}", fields: ["table"] }),
  operation({ id: "vschema", label: "VSchema 상세", category: "schema", access: "viewer", method: "GET", path: "/api/vschema/{cluster}/{keyspace}", fields: ["cluster", "keyspace"] }),
  operation({ id: "tablet", label: "Tablet 상세", category: "inventory", access: "viewer", method: "GET", path: "/api/tablet/{tablet}", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" } }),
  operation({ id: "tablet_full_status", label: "MySQL Full Status", category: "replication", access: "viewer", method: "GET", path: "/api/tablet/{tablet}/full_status", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" } }),
  operation({ id: "tablet_ping", label: "Tablet Ping", category: "diagnostics", access: "viewer", method: "GET", path: "/api/tablet/{tablet}/ping", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" } }),
  operation({ id: "tablet_health", label: "Tablet Health Check", category: "diagnostics", access: "viewer", method: "GET", path: "/api/tablet/{tablet}/healthcheck", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" } }),
  operation({ id: "tablet_debug_vars", label: "Tablet Debug Vars", category: "diagnostics", access: "viewer", method: "GET", path: "/api/experimental/tablet/{tablet}/debug/vars", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" } }),
  operation({ id: "whoami", label: "VTAdmin 현재 사용자", category: "diagnostics", access: "viewer", method: "GET", path: "/api/experimental/whoami", description: "VTAdmin이 인식한 사용자와 권한 주체" }),
  operation({ id: "workflow", label: "Workflow 상세", category: "workflow", access: "viewer", method: "GET", path: "/api/workflow/{cluster}/{keyspace}/{workflow}", fields: ["cluster", "keyspace", "workflow"] }),
  operation({ id: "workflow_status", label: "Workflow 상태", category: "workflow", access: "viewer", method: "GET", path: "/api/workflow/{cluster}/{keyspace}/{workflow}/status", fields: ["cluster", "keyspace", "workflow"] }),
  operation({ id: "srv_keyspace", label: "Serving Keyspace 상세", category: "topology", access: "viewer", method: "GET", path: "/api/srvkeyspace/{cluster}/{keyspace}", fields: ["cluster", "keyspace"] }),
  operation({ id: "srv_vschema", label: "Serving VSchema 상세", category: "topology", access: "viewer", method: "GET", path: "/api/srvvschema/{cluster}/{cell}", fields: ["cluster", "cell"] }),
  operation({ id: "topology_path", label: "Topology 경로", category: "topology", access: "viewer", method: "GET", path: "/api/cluster/{cluster}/topology", fields: ["cluster", "topologyPath"], queryFromFields: { topologyPath: "path" } }),
  operation({ id: "transactions", label: "미해결 트랜잭션", category: "transactions", access: "viewer", method: "GET", path: "/api/transactions/{cluster}/{keyspace}", fields: ["cluster", "keyspace"], defaultQuery: { abandon_age: "0" } }),
  operation({ id: "transaction", label: "트랜잭션 상세", category: "transactions", access: "viewer", method: "GET", path: "/api/transaction/{cluster}/{dtid}/info", fields: ["cluster", "dtid"] }),
  operation({ id: "migrations", label: "Schema Migration", category: "schema", access: "viewer", method: "POST", path: "/api/migrations/", description: "Online DDL 상태", defaultBody: {} }),
  operation({ id: "vdiff_show", label: "VDiff 조회", category: "workflow", access: "viewer", method: "POST", path: "/api/vdiff/{cluster}/show", fields: ["cluster"], defaultBody: { target_keyspace: "", workflow: "", arg: "all" } }),
  operation({ id: "vexplain", label: "VExplain", category: "explain", access: "viewer", method: "GET", path: "/api/vexplain", fields: ["cluster", "keyspace", "sql"], queryFromFields: { cluster: "cluster_id", keyspace: "keyspace", sql: "sql" } }),
  operation({ id: "vtexplain", label: "VTExplain", category: "explain", access: "viewer", method: "GET", path: "/api/vtexplain", fields: ["cluster", "keyspace", "sql"], queryFromFields: { cluster: "cluster", keyspace: "keyspace", sql: "sql" } }),
]);

export const DBA_OPERATIONS = Object.freeze([
  operation({ id: "validate_cluster", label: "Cluster 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/cluster/{cluster}/validate", fields: ["cluster"], defaultBody: { ping_tablets: true }, description: "전체 토폴로지 일관성 검증" }),
  operation({ id: "validate_keyspace", label: "Keyspace 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/keyspace/{cluster}/{keyspace}/validate", fields: ["cluster", "keyspace"], defaultBody: { pingTablets: true } }),
  operation({ id: "validate_schema_keyspace", label: "Schema 일관성 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/keyspace/{cluster}/{keyspace}/validate/schema", fields: ["cluster", "keyspace"], defaultBody: {} }),
  operation({ id: "validate_version_keyspace", label: "Keyspace 버전 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/keyspace/{cluster}/{keyspace}/validate/version", fields: ["cluster", "keyspace"], defaultBody: {} }),
  operation({ id: "validate_shard", label: "Shard 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/shard/{cluster}/{keyspace}/{shard}/validate", fields: ["cluster", "keyspace", "shard"], defaultBody: { ping_tablets: true } }),
  operation({ id: "validate_version_shard", label: "Shard 버전 검증", category: "diagnostics", access: "dba", severity: "low", method: "PUT", path: "/api/shard/{cluster}/{keyspace}/{shard}/validate_version", fields: ["cluster", "keyspace", "shard"], defaultBody: {} }),
  operation({ id: "create_keyspace", label: "Keyspace 생성", category: "topology", access: "dba", severity: "high", method: "POST", path: "/api/keyspace/{cluster}", fields: ["cluster", "newKeyspace"], bodyFromFields: { newKeyspace: "name" }, defaultBody: { force: false, allow_empty_v_schema: true, durability_policy: "none" } }),
  operation({ id: "delete_keyspace", label: "Keyspace 삭제", category: "topology", access: "dba", severity: "critical", method: "DELETE", path: "/api/keyspace/{cluster}/{keyspace}", fields: ["cluster", "keyspace"], defaultQuery: { recursive: false } }),
  operation({ id: "create_shard", label: "Shard 생성", category: "topology", access: "dba", severity: "high", method: "POST", path: "/api/shards/{cluster}", fields: ["cluster", "keyspace", "shard"], bodyFromFields: { keyspace: "keyspace", shard: "shard_name" }, defaultBody: { force: false, include_parent: false } }),
  operation({ id: "delete_shard", label: "Shard 삭제", category: "topology", access: "dba", severity: "critical", method: "DELETE", path: "/api/shards/{cluster}", fields: ["cluster", "keyspace", "shard"], combineKeyspaceShard: true, defaultQuery: { recursive: false, even_if_serving: false } }),
  operation({ id: "delete_tablet", label: "Tablet 삭제", category: "tablet", access: "dba", severity: "critical", method: "DELETE", path: "/api/tablet/{tablet}", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultQuery: { allow_primary: false } }),
  operation({ id: "rebuild_keyspace_graph", label: "Serving Graph 재구성", category: "topology", access: "dba", severity: "high", method: "PUT", path: "/api/keyspace/{cluster}/{keyspace}/rebuild_keyspace_graph", fields: ["cluster", "keyspace"], defaultBody: { cells: "", allow_partial: false } }),
  operation({ id: "remove_keyspace_cell", label: "Keyspace Cell 제거", category: "topology", access: "dba", severity: "critical", method: "PUT", path: "/api/keyspace/{cluster}/{keyspace}/remove_keyspace_cell", fields: ["cluster", "keyspace"], defaultBody: { cell: "", force: false, recursive: false } }),
  operation({ id: "planned_failover", label: "Planned Failover", category: "ha", access: "dba", severity: "high", method: "POST", path: "/api/shard/{cluster}/{keyspace}/{shard}/planned_failover", fields: ["cluster", "keyspace", "shard"], defaultBody: {} }),
  operation({ id: "emergency_failover", label: "Emergency Failover", category: "ha", access: "dba", severity: "critical", method: "POST", path: "/api/shard/{cluster}/{keyspace}/{shard}/emergency_failover", fields: ["cluster", "keyspace", "shard"], defaultBody: {} }),
  operation({ id: "tablet_externally_promoted", label: "외부 Primary 승격 반영", category: "ha", access: "dba", severity: "critical", method: "POST", path: "/api/tablet/{tablet}/externally_promoted", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "refresh_state", label: "Tablet 상태 갱신", category: "tablet", access: "dba", severity: "low", method: "PUT", path: "/api/tablet/{tablet}/refresh", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "refresh_replication_source", label: "Replication Source 갱신", category: "replication", access: "dba", severity: "high", method: "PUT", path: "/api/tablet/{tablet}/refresh_replication_source", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "set_read_only", label: "Tablet Read Only", category: "tablet", access: "dba", severity: "high", method: "PUT", path: "/api/tablet/{tablet}/set_read_only", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "set_read_write", label: "Tablet Read Write", category: "tablet", access: "dba", severity: "critical", method: "PUT", path: "/api/tablet/{tablet}/set_read_write", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "start_replication", label: "Replication 시작", category: "replication", access: "dba", severity: "high", method: "PUT", path: "/api/tablet/{tablet}/start_replication", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "stop_replication", label: "Replication 중지", category: "replication", access: "dba", severity: "critical", method: "PUT", path: "/api/tablet/{tablet}/stop_replication", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "reload_schemas", label: "Schema 전체 Reload", category: "schema", access: "dba", severity: "medium", method: "PUT", path: "/api/schemas/reload", fields: ["cluster"], queryFromFields: { cluster: "cluster_id" }, defaultQuery: { concurrency: 4, include_primary: false } }),
  operation({ id: "reload_schema_shard", label: "Shard Schema Reload", category: "schema", access: "dba", severity: "medium", method: "PUT", path: "/api/shard/{cluster}/{keyspace}/{shard}/reload_schema_shard", fields: ["cluster", "keyspace", "shard"], defaultBody: { include_primary: false, concurrency: 4, wait_position: "" } }),
  operation({ id: "reload_tablet_schema", label: "Tablet Schema Reload", category: "schema", access: "dba", severity: "medium", method: "PUT", path: "/api/tablet/{tablet}/reload_schema", fields: ["cluster", "tablet"], queryFromFields: { cluster: "cluster_id" }, defaultBody: {} }),
  operation({ id: "apply_schema", label: "Schema 적용 / Online DDL", category: "schema", access: "dba", severity: "critical", method: "POST", path: "/api/migration/{cluster}/{keyspace}", fields: ["cluster", "keyspace"], defaultBody: { sql: "CREATE TABLE example_table (id BIGINT PRIMARY KEY)", caller_id: "vtatlas-dba", request: { ddl_strategy: "online" } } }),
  operation({ id: "cancel_migration", label: "Migration 취소", category: "schema", access: "dba", severity: "high", method: "PUT", path: "/api/migration/{cluster}/{keyspace}/cancel", fields: ["cluster", "keyspace", "uuid"], queryFromFields: { uuid: "uuid" }, defaultBody: {} }),
  operation({ id: "cleanup_migration", label: "Migration Cleanup", category: "schema", access: "dba", severity: "high", method: "PUT", path: "/api/migration/{cluster}/{keyspace}/cleanup", fields: ["cluster", "keyspace", "uuid"], queryFromFields: { uuid: "uuid" }, defaultBody: {} }),
  operation({ id: "complete_migration", label: "Migration 완료", category: "schema", access: "dba", severity: "high", method: "PUT", path: "/api/migration/{cluster}/{keyspace}/complete", fields: ["cluster", "keyspace", "uuid"], queryFromFields: { uuid: "uuid" }, defaultBody: {} }),
  operation({ id: "launch_migration", label: "Migration 실행", category: "schema", access: "dba", severity: "high", method: "PUT", path: "/api/migration/{cluster}/{keyspace}/launch", fields: ["cluster", "keyspace", "uuid"], queryFromFields: { uuid: "uuid" }, defaultBody: {} }),
  operation({ id: "retry_migration", label: "Migration 재시도", category: "schema", access: "dba", severity: "high", method: "PUT", path: "/api/migration/{cluster}/{keyspace}/retry", fields: ["cluster", "keyspace", "uuid"], queryFromFields: { uuid: "uuid" }, defaultBody: {} }),
  operation({ id: "start_workflow", label: "Workflow 시작", category: "workflow", access: "dba", severity: "high", method: "GET", path: "/api/workflow/{cluster}/{keyspace}/{workflow}/start", fields: ["cluster", "keyspace", "workflow"] }),
  operation({ id: "stop_workflow", label: "Workflow 중지", category: "workflow", access: "dba", severity: "high", method: "GET", path: "/api/workflow/{cluster}/{keyspace}/{workflow}/stop", fields: ["cluster", "keyspace", "workflow"] }),
  operation({ id: "create_materialize", label: "Materialize 생성", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/workflow/{cluster}/materialize", fields: ["cluster"], defaultBody: { table_settings: "[]", request: { workflow: "", target_keyspace: "", settings: {} } } }),
  operation({ id: "create_movetables", label: "MoveTables 생성", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/workflow/{cluster}/movetables", fields: ["cluster"], defaultBody: { workflow: "", source_keyspace: "", target_keyspace: "", all_tables: false, include_tables: [] } }),
  operation({ id: "create_reshard", label: "Reshard 생성", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/workflow/{cluster}/reshard", fields: ["cluster"], defaultBody: { workflow: "", keyspace: "", source_shards: [], target_shards: [] } }),
  operation({ id: "complete_movetables", label: "MoveTables 완료", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/movetables/{cluster}/complete", fields: ["cluster"], defaultBody: { workflow: "", target_keyspace: "", keep_data: false, keep_routing_rules: false } }),
  operation({ id: "switch_workflow_traffic", label: "Workflow Traffic 전환", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/workflow/{cluster}/switchtraffic", fields: ["cluster"], defaultBody: { keyspace: "", workflow: "", direction: "FORWARD", tablet_types: ["PRIMARY", "REPLICA", "RDONLY"] } }),
  operation({ id: "delete_workflow", label: "Workflow 삭제", category: "workflow", access: "dba", severity: "critical", method: "POST", path: "/api/workflow/{cluster}/delete", fields: ["cluster"], defaultBody: { keyspace: "", workflow: "", keep_data: false, keep_routing_rules: false } }),
  operation({ id: "create_vdiff", label: "VDiff 생성", category: "workflow", access: "dba", severity: "medium", method: "POST", path: "/api/vdiff/{cluster}/", fields: ["cluster"], defaultBody: { target_keyspace: "", workflow: "", uuid: "" } }),
  operation({ id: "conclude_transaction", label: "분산 트랜잭션 종료", category: "transactions", access: "dba", severity: "critical", method: "GET", path: "/api/transaction/{cluster}/{dtid}/conclude", fields: ["cluster", "dtid"] }),
]);

const operationMap = new Map(
  [...READ_OPERATIONS, ...DBA_OPERATIONS].map((item) => [item.id, item]),
);

export function getOperation(id, access) {
  const item = operationMap.get(String(id ?? ""));
  if (!item || item.access !== access) {
    const error = new Error(`unsupported ${access} operation`);
    error.status = 404;
    throw error;
  }
  return item;
}

function validateField(name, value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2048 || CONTROL_RE.test(text)) {
    throw new Error(`${name} is required`);
  }
  if (name === "sql" || name === "topologyPath") return text;
  if (name === "tablet" && !TABLET_RE.test(text)) {
    throw new Error("tablet alias must use cell-uid format");
  }
  if (!FIELD_RE.test(text)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return text;
}

function applyTemplate(template, fields) {
  return template.replace(/\{([A-Za-z]+)\}/g, (_match, name) => {
    return encodeURIComponent(validateField(name, fields[name]));
  });
}

function addQuery(search, key, value) {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((item) => addQuery(search, key, item));
    return;
  }
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new Error(`query value for ${key} must be scalar or an array`);
  }
  search.append(key, String(value));
}

function safeObject(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return structuredClone(value);
}

export function buildOperationRequest(item, payload = {}) {
  const fields = safeObject(payload.fields, "fields");
  for (const name of item.fields) validateField(name, fields[name]);
  const query = {
    ...safeObject(item.defaultQuery, "default query"),
    ...safeObject(payload.query, "query"),
  };
  for (const [field, key] of Object.entries(item.queryFromFields ?? {})) {
    query[key] = validateField(field, fields[field]);
  }
  if (item.combineKeyspaceShard) {
    query.keyspace_shard = `${validateField("keyspace", fields.keyspace)}/${validateField("shard", fields.shard)}`;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) addQuery(search, key, value);

  let body =
    payload.body === undefined
      ? item.defaultBody === undefined
        ? undefined
        : safeObject(item.defaultBody, "default body")
      : safeObject(payload.body, "body");
  if (item.bodyFromFields) {
    body ??= {};
    for (const [field, key] of Object.entries(item.bodyFromFields)) {
      body[key] = validateField(field, fields[field]);
    }
  }
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  if (encodedBody && Buffer.byteLength(encodedBody) > 128 * 1024) {
    throw new Error("operation body is too large");
  }
  const suffix = search.size ? `?${search}` : "";
  return {
    method: item.method,
    path: `${applyTemplate(item.path, fields)}${suffix}`,
    body: encodedBody,
    headers: encodedBody ? { "Content-Type": "application/json" } : {},
  };
}

export function confirmationPhrase(item, payload) {
  const fields = safeObject(payload?.fields, "fields");
  const target = item.fields
    .filter((field) => field !== "sql" && field !== "topologyPath")
    .map((field) => fields[field])
    .filter(Boolean)
    .join("/");
  return `EXECUTE ${item.id}${target ? ` ${target}` : ""}`;
}

export function publicOperation(item) {
  return {
    id: item.id,
    label: item.label,
    category: item.category,
    access: item.access,
    severity: item.severity,
    description: item.description,
    fields: item.fields,
    defaultBody: item.defaultBody,
    defaultQuery: item.defaultQuery,
  };
}
