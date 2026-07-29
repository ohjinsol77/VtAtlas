const state = {
  viewerOperations: [],
  dbaOperations: [],
  dbaActive: false,
  activeCategory: "overview",
  selectedOperation: null,
  approval: null,
  inventory: {
    clusters: [],
    keyspaces: [],
    tablets: [],
  },
};

const elements = {
  roleLabel: document.querySelector("#admin-role-label"),
  liveDot: document.querySelector("#admin-live-dot"),
  status: document.querySelector("#admin-status"),
  statusDetail: document.querySelector("#admin-status-detail"),
  notice: document.querySelector("#admin-notice"),
  dbaButton: document.querySelector("#dba-mode-button"),
  categoryNav: document.querySelector("#admin-category-nav"),
  sidebarBadge: document.querySelector("#sidebar-mode-badge"),
  sidebarTitle: document.querySelector("#sidebar-mode-title"),
  sidebarDetail: document.querySelector("#sidebar-mode-detail"),
  scopeCluster: document.querySelector("#scope-cluster"),
  scopeKeyspace: document.querySelector("#scope-keyspace"),
  scopeShard: document.querySelector("#scope-shard"),
  scopeTablet: document.querySelector("#scope-tablet"),
  inventoryRefresh: document.querySelector("#inventory-refresh"),
  overview: document.querySelector("#admin-overview"),
  operationSection: document.querySelector("#operation-section"),
  operationTitle: document.querySelector("#operation-title"),
  operationDescription: document.querySelector("#operation-description"),
  operationCount: document.querySelector("#operation-count"),
  operationGrid: document.querySelector("#operation-grid"),
  auditSection: document.querySelector("#audit-section"),
  auditRefresh: document.querySelector("#audit-refresh"),
  auditList: document.querySelector("#audit-list"),
  resultTitle: document.querySelector("#result-title"),
  resultMeta: document.querySelector("#result-meta"),
  resultOutput: document.querySelector("#result-output"),
  resultClear: document.querySelector("#result-clear"),
  dbaDialog: document.querySelector("#dba-entry-dialog"),
  dbaForm: document.querySelector("#dba-entry-form"),
  dbaAck: document.querySelector("#dba-acknowledgement"),
  dbaError: document.querySelector("#dba-entry-error"),
  operationDialog: document.querySelector("#operation-dialog"),
  operationForm: document.querySelector("#operation-form"),
  dialogAccess: document.querySelector("#dialog-access"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogDescription: document.querySelector("#dialog-description"),
  severity: document.querySelector("#operation-severity"),
  fields: document.querySelector("#operation-fields"),
  queryField: document.querySelector("#query-editor-field"),
  bodyField: document.querySelector("#body-editor-field"),
  query: document.querySelector("#operation-query"),
  body: document.querySelector("#operation-body"),
  prepareSummary: document.querySelector("#prepare-summary"),
  confirmationField: document.querySelector("#confirmation-field"),
  confirmation: document.querySelector("#operation-confirmation"),
  confirmationHelp: document.querySelector("#confirmation-help"),
  operationMessage: document.querySelector("#operation-message"),
  operationSubmit: document.querySelector("#operation-submit"),
};

const categoryLabels = {
  inventory: ["Cluster · Tablet", "Cluster, Keyspace, Tablet과 제어 프로세스 정보를 조회합니다."],
  topology: ["토폴로지", "Cell, Serving Graph, Topology 경로와 Keyspace·Shard 구성을 관리합니다."],
  diagnostics: ["상태 · 진단", "Ping, Health Check와 Cluster·Keyspace·Shard 일관성을 검증합니다."],
  replication: ["복제 · HA", "복제 위치를 조회하고 Replication Source와 실행 상태를 제어합니다."],
  schema: ["Schema", "Schema·VSchema·Migration을 조회, 검증, Reload 또는 적용합니다."],
  workflow: ["Workflow · VDiff", "VReplication Workflow, Traffic 전환, VDiff를 관리합니다."],
  transactions: ["트랜잭션", "미해결 분산 트랜잭션을 조회하고 DBA가 종료 처리합니다."],
  explain: ["Explain", "VExplain과 VTExplain으로 SQL 라우팅 계획을 확인합니다."],
  tablet: ["Tablet 제어", "Tablet 상태와 writability를 제어합니다."],
  ha: ["HA 작업", "Planned/Emergency Failover와 외부 승격 반영을 수행합니다."],
};

const fieldLabels = {
  cluster: "Cluster ID",
  keyspace: "Keyspace",
  newKeyspace: "새 Keyspace",
  shard: "Shard",
  tablet: "Tablet Alias",
  table: "Table",
  cell: "Cell",
  workflow: "Workflow",
  dtid: "DTID",
  uuid: "Migration / VDiff UUID",
  sql: "SQL",
  topologyPath: "Topology Path",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setOptions(select, values, placeholder, current = "") {
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), "ko"),
  );
  select.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...unique.map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`,
    ),
  ].join("");
  if (unique.includes(current)) select.value = current;
}

function unwrapRead(payload, key) {
  const body = payload?.result?.result ?? payload?.result ?? payload ?? {};
  const value = key ? body[key] : body;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function clusterId(item) {
  return item?.cluster?.id ?? item?.cluster_id ?? item?.id ?? "";
}

function keyspaceName(item) {
  return item?.keyspace?.name ?? item?.name ?? "";
}

function tabletAlias(item) {
  const alias = item?.tablet?.alias ?? item?.alias;
  if (typeof alias === "string") return alias;
  if (!alias?.cell || !Number.isFinite(Number(alias.uid))) return "";
  return `${alias.cell}-${String(alias.uid).padStart(10, "0")}`;
}

function tabletKeyspace(item) {
  return item?.tablet?.keyspace ?? item?.keyspace ?? "";
}

function tabletShard(item) {
  return item?.tablet?.shard ?? item?.shard ?? "";
}

function keyspaceShards(item) {
  const shards = item?.shards ?? item?.keyspace?.shards ?? {};
  return Array.isArray(shards)
    ? shards.map((entry) => entry?.name ?? entry?.shard?.name ?? entry)
    : Object.keys(shards);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `HTTP ${response.status}`,
  }));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? payload?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function viewerRequest(operationId, payload = {}) {
  return requestJson("/api/admin/read", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VtAtlas-Admin-Intent": "read-vtadmin",
    },
    body: JSON.stringify({ operationId, ...payload }),
  });
}

function showResult(title, payload, meta = "") {
  elements.resultTitle.textContent = title;
  elements.resultMeta.textContent = meta || new Date().toLocaleString("ko-KR");
  elements.resultOutput.textContent = JSON.stringify(payload, null, 2);
  elements.resultOutput.scrollTop = 0;
}

function showStatus(kind, title, detail) {
  elements.liveDot.className = `live-dot ${kind}`;
  elements.status.textContent = title;
  elements.statusDetail.textContent = detail;
}

async function loadCatalogs() {
  const viewer = await requestJson("/api/admin/catalog");
  state.viewerOperations = viewer.operations ?? [];
  try {
    const operator = await requestJson("/api/operator/catalog");
    state.dbaOperations = operator.operations ?? [];
  } catch {
    state.dbaOperations = [];
  }
}

async function readSession() {
  try {
    const session = await requestJson("/api/operator/session");
    state.dbaActive = Boolean(session.active);
  } catch {
    state.dbaActive = false;
  }
  renderMode();
}

function renderMode() {
  const active = state.dbaActive;
  elements.roleLabel.textContent = active
    ? "OPERATIONS · DBA"
    : "OPERATIONS · VIEWER";
  elements.dbaButton.textContent = active ? "DBA 모드 종료" : "DBA 모드 진입";
  elements.dbaButton.classList.toggle("active", active);
  elements.sidebarBadge.className = `role-badge ${active ? "dba" : "viewer"}`;
  elements.sidebarBadge.textContent = active ? "DBA" : "VIEWER";
  elements.sidebarTitle.textContent = active ? "제한된 쓰기 권한" : "읽기 전용";
  elements.sidebarDetail.textContent = active
    ? "변경 작업은 사전검증과 일회성 확인 후 실행됩니다."
    : "변경 API는 현재 화면에 노출되지 않습니다.";
  elements.notice.classList.toggle("dba-active", active);
  elements.notice.innerHTML = active
    ? "<strong>DBA 모드</strong><span>제한된 쓰기 권한이 활성화되었습니다. 실제 대상을 확인하고 작업별 최종 확인 문구를 입력하세요.</span>"
    : "<strong>Viewer 모드</strong><span>현재 화면은 읽기 전용 VTAdmin API만 사용합니다. 변경 작업은 DBA 모드에서 별도 Operator API의 사전검증과 확인 절차를 거칩니다.</span>";
  document
    .querySelectorAll('[data-category="tablet"], [data-category="ha"], [data-category="audit"]')
    .forEach((button) => button.classList.toggle("dba-only", !active));
  renderCategory();
}

function updateScope() {
  const cluster = elements.scopeCluster.value;
  const previousKeyspace = elements.scopeKeyspace.value;
  const keyspaces = state.inventory.keyspaces.filter(
    (item) => !cluster || clusterId(item) === cluster,
  );
  setOptions(
    elements.scopeKeyspace,
    keyspaces.map(keyspaceName),
    "전체 Keyspace",
    previousKeyspace,
  );

  const keyspace = elements.scopeKeyspace.value;
  const selectedKeyspaces = keyspaces.filter(
    (item) => !keyspace || keyspaceName(item) === keyspace,
  );
  const previousShard = elements.scopeShard.value;
  setOptions(
    elements.scopeShard,
    selectedKeyspaces.flatMap(keyspaceShards),
    "전체 Shard",
    previousShard,
  );

  const shard = elements.scopeShard.value;
  const previousTablet = elements.scopeTablet.value;
  const tablets = state.inventory.tablets.filter(
    (item) =>
      (!cluster || clusterId(item) === cluster) &&
      (!keyspace || tabletKeyspace(item) === keyspace) &&
      (!shard || tabletShard(item) === shard),
  );
  setOptions(
    elements.scopeTablet,
    tablets.map(tabletAlias),
    "전체 Tablet",
    previousTablet,
  );
}

function renderSummary() {
  const shardCount = state.inventory.keyspaces.reduce(
    (total, item) => total + keyspaceShards(item).length,
    0,
  );
  const unsharded = state.inventory.keyspaces.filter((item) => {
    const shards = keyspaceShards(item);
    return shards.length === 1 && shards[0] === "0";
  }).length;
  document.querySelector("#summary-clusters").textContent =
    state.inventory.clusters.length;
  document.querySelector("#summary-keyspaces").textContent =
    state.inventory.keyspaces.length;
  document.querySelector("#summary-shards").textContent = shardCount;
  document.querySelector("#summary-tablets").textContent =
    state.inventory.tablets.length;
  document.querySelector("#summary-sharding").textContent =
    `노샤딩 ${unsharded} · 샤딩 ${Math.max(0, state.inventory.keyspaces.length - unsharded)}`;
}

async function loadInventory() {
  elements.inventoryRefresh.disabled = true;
  showStatus("", "VTAdmin 조회 중", "Cluster · Keyspace · Tablet 목록을 갱신합니다");
  try {
    const [clusters, keyspaces, tablets] = await Promise.all([
      viewerRequest("clusters"),
      viewerRequest("keyspaces"),
      viewerRequest("tablets"),
    ]);
    state.inventory = {
      clusters: unwrapRead(clusters, "clusters"),
      keyspaces: unwrapRead(keyspaces, "keyspaces"),
      tablets: unwrapRead(tablets, "tablets"),
    };
    const currentCluster = elements.scopeCluster.value;
    setOptions(
      elements.scopeCluster,
      state.inventory.clusters.map((item) => item.id),
      "전체 Cluster",
      currentCluster,
    );
    updateScope();
    renderSummary();
    showStatus(
      "healthy",
      `${state.inventory.clusters.length}개 Cluster 연결`,
      `Keyspace ${state.inventory.keyspaces.length} · Tablet ${state.inventory.tablets.length}`,
    );
  } catch (error) {
    showStatus("error", "VTAdmin 조회 실패", error.message);
    showResult("목록 갱신 실패", { error: error.message }, "Viewer API");
  } finally {
    elements.inventoryRefresh.disabled = false;
  }
}

function operationsForCategory(category) {
  const operations = [...state.viewerOperations];
  if (state.dbaActive) operations.push(...state.dbaOperations);
  return operations.filter((item) => {
    if (category === "replication") {
      return ["replication"].includes(item.category);
    }
    return item.category === category;
  });
}

function severityLabel(severity) {
  return (
    {
      info: "조회",
      low: "낮음",
      medium: "보통",
      high: "높음",
      critical: "매우 높음",
    }[severity] ?? severity
  );
}

function renderOperationCard(item) {
  const access = item.access === "dba" ? "DBA" : "VIEWER";
  return `
    <article class="operation-card ${escapeHtml(item.access)} severity-${escapeHtml(item.severity)}">
      <header>
        <span class="role-badge ${escapeHtml(item.access)}">${access}</span>
        <span class="severity-chip ${escapeHtml(item.severity)}">${escapeHtml(severityLabel(item.severity))}</span>
      </header>
      <h3>${escapeHtml(item.label)}</h3>
      <p>${escapeHtml(item.description || `${item.fields.length ? item.fields.join(" · ") : "전체 범위"} 작업`)}</p>
      <footer>
        <span>${item.fields.length ? escapeHtml(item.fields.join(" / ")) : "전체"}</span>
        <button type="button" data-operation-id="${escapeHtml(item.id)}">
          ${item.access === "dba" ? "준비" : "열기"} →
        </button>
      </footer>
    </article>
  `;
}

function renderCategory() {
  const category = state.activeCategory;
  elements.overview.classList.toggle("hidden", category !== "overview");
  elements.operationSection.classList.toggle(
    "hidden",
    category === "overview" || category === "audit",
  );
  elements.auditSection.classList.toggle("hidden", category !== "audit");
  if (category === "overview") return;
  if (category === "audit") {
    if (state.dbaActive) void loadAudit();
    else state.activeCategory = "overview";
    return;
  }
  if (!state.dbaActive && ["tablet", "ha"].includes(category)) {
    state.activeCategory = "overview";
    renderCategory();
    return;
  }
  const [title, description] = categoryLabels[category] ?? [category, ""];
  const operations = operationsForCategory(category);
  elements.operationTitle.textContent = title;
  elements.operationDescription.textContent = description;
  elements.operationCount.textContent = `${operations.length}개 기능`;
  elements.operationGrid.innerHTML = operations.length
    ? operations.map(renderOperationCard).join("")
    : '<div class="empty-operations">현재 권한에서 사용할 수 있는 기능이 없습니다.</div>';
}

function defaultFieldValue(name) {
  if (name === "cluster") return elements.scopeCluster.value;
  if (name === "keyspace") return elements.scopeKeyspace.value;
  if (name === "shard") return elements.scopeShard.value;
  if (name === "tablet") return elements.scopeTablet.value;
  if (name === "topologyPath") return "/";
  return "";
}

function openOperation(item) {
  state.selectedOperation = item;
  state.approval = null;
  elements.dialogAccess.textContent =
    item.access === "dba" ? `DBA · ${severityLabel(item.severity)}` : "VIEWER";
  elements.dialogTitle.textContent = item.label;
  elements.dialogDescription.textContent =
    item.description || "VTAdmin API 요청을 실행합니다.";
  elements.severity.className = `operation-severity ${item.severity}`;
  elements.severity.textContent =
    item.access === "dba"
      ? `변경 작업 · 위험도 ${severityLabel(item.severity)}`
      : "읽기 전용 작업";
  elements.fields.innerHTML = item.fields
    .map((name) => {
      const multiline = name === "sql";
      const value = defaultFieldValue(name);
      return `
        <label class="admin-dialog-field">
          <span>${escapeHtml(fieldLabels[name] ?? name)}</span>
          ${
            multiline
              ? `<textarea data-operation-field="${escapeHtml(name)}" rows="5" required>${escapeHtml(value)}</textarea>`
              : `<input data-operation-field="${escapeHtml(name)}" value="${escapeHtml(value)}" autocomplete="off" required />`
          }
        </label>
      `;
    })
    .join("");
  elements.query.value = JSON.stringify(item.defaultQuery ?? {}, null, 2);
  elements.body.value = JSON.stringify(item.defaultBody ?? {}, null, 2);
  elements.queryField.classList.toggle(
    "hidden",
    !item.defaultQuery && !["delete_keyspace", "delete_tablet"].includes(item.id),
  );
  elements.bodyField.classList.toggle(
    "hidden",
    item.defaultBody === undefined && item.access === "viewer",
  );
  elements.prepareSummary.classList.add("hidden");
  elements.prepareSummary.innerHTML = "";
  elements.confirmationField.classList.add("hidden");
  elements.confirmation.value = "";
  elements.operationMessage.textContent = "";
  elements.operationSubmit.textContent =
    item.access === "dba" ? "사전검증" : "조회 실행";
  elements.operationSubmit.className =
    item.access === "dba" ? "danger-button" : "primary-button";
  elements.operationDialog.showModal();
}

function parseObject(value, label) {
  let parsed;
  try {
    parsed = value.trim() ? JSON.parse(value) : {};
  } catch {
    throw new Error(`${label}이 올바른 JSON이 아닙니다.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}은 JSON 객체여야 합니다.`);
  }
  return parsed;
}

function operationPayload() {
  const fields = Object.fromEntries(
    [...elements.fields.querySelectorAll("[data-operation-field]")].map((input) => [
      input.dataset.operationField,
      input.value.trim(),
    ]),
  );
  return {
    actionId: state.selectedOperation.id,
    operationId: state.selectedOperation.id,
    fields,
    query: parseObject(elements.query.value, "Query"),
    body: parseObject(elements.body.value, "Request Body"),
  };
}

async function submitOperation(event) {
  event.preventDefault();
  const item = state.selectedOperation;
  if (!item) return;
  elements.operationMessage.textContent = "";
  elements.operationSubmit.disabled = true;
  try {
    if (item.access === "viewer") {
      const payload = operationPayload();
      const result = await viewerRequest(item.id, payload);
      showResult(item.label, result.result, `Viewer · HTTP ${result.upstreamStatus}`);
      elements.operationDialog.close();
      return;
    }
    if (!state.approval) {
      const prepared = await requestJson("/api/operator/prepare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VtAtlas-DBA-Intent": "prepare-operation",
        },
        body: JSON.stringify(operationPayload()),
      });
      state.approval = prepared;
      elements.prepareSummary.classList.remove("hidden");
      elements.prepareSummary.innerHTML = `
        <strong>사전검증 완료</strong>
        <dl>
          <div><dt>대상</dt><dd>${escapeHtml([
            prepared.target?.cluster?.id,
            prepared.target?.keyspace,
            prepared.target?.shard,
            prepared.target?.tablet,
          ].filter(Boolean).join(" / "))}</dd></div>
          <div><dt>Upstream</dt><dd>${escapeHtml(`${prepared.upstream?.method} ${prepared.upstream?.path}`)}</dd></div>
          <div><dt>승인 만료</dt><dd>${escapeHtml(new Date(prepared.expiresAt).toLocaleString("ko-KR"))}</dd></div>
        </dl>
      `;
      elements.confirmationField.classList.remove("hidden");
      elements.confirmationHelp.textContent =
        `다음을 정확히 입력: ${prepared.confirmationPhrase}`;
      elements.confirmation.placeholder = prepared.confirmationPhrase;
      elements.operationSubmit.textContent = "최종 실행";
      elements.operationMessage.textContent =
        "대상과 Upstream 경로를 확인한 뒤 최종 확인 문구를 입력하세요.";
      return;
    }
    const result = await requestJson("/api/operator/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VtAtlas-DBA-Intent": "execute-operation",
      },
      body: JSON.stringify({
        approvalToken: state.approval.approvalToken,
        confirmation: elements.confirmation.value,
      }),
    });
    showResult(
      item.label,
      result.result,
      `DBA · Audit ${result.auditId} · ${result.durationMs}ms`,
    );
    elements.operationDialog.close();
    state.approval = null;
  } catch (error) {
    elements.operationMessage.textContent = error.message;
  } finally {
    elements.operationSubmit.disabled = false;
  }
}

async function enableDba(event) {
  event.preventDefault();
  elements.dbaError.textContent = "";
  try {
    await requestJson("/api/operator/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VtAtlas-DBA-Intent": "enable-dba-mode",
      },
      body: JSON.stringify({ acknowledgement: elements.dbaAck.value }),
    });
    state.dbaActive = true;
    elements.dbaDialog.close();
    elements.dbaAck.value = "";
    renderMode();
  } catch (error) {
    elements.dbaError.textContent = error.message;
  }
}

async function toggleDba() {
  if (!state.dbaActive) {
    elements.dbaError.textContent = "";
    elements.dbaDialog.showModal();
    elements.dbaAck.focus();
    return;
  }
  try {
    await requestJson("/api/operator/session", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-VtAtlas-DBA-Intent": "disable-dba-mode",
      },
      body: "{}",
    });
  } finally {
    state.dbaActive = false;
    state.activeCategory = "overview";
    renderMode();
  }
}

async function loadAudit() {
  if (!state.dbaActive) return;
  elements.auditList.innerHTML = '<div class="audit-loading">감사 로그를 불러오는 중…</div>';
  try {
    const result = await requestJson("/api/operator/audit");
    const entries = result.entries ?? [];
    elements.auditList.innerHTML = entries.length
      ? entries
          .map(
            (entry) => `
              <article class="audit-entry ${escapeHtml(entry.success === false ? "failed" : "")}">
                <header>
                  <strong>${escapeHtml(entry.type)}</strong>
                  <time>${escapeHtml(new Date(entry.at).toLocaleString("ko-KR"))}</time>
                </header>
                <p>${escapeHtml([
                  entry.actionId,
                  entry.target?.cluster?.id,
                  entry.target?.keyspace,
                  entry.target?.shard,
                  entry.target?.tablet,
                ].filter(Boolean).join(" · ") || "DBA session")}</p>
                <pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
              </article>
            `,
          )
          .join("")
      : '<div class="empty-operations">기록된 DBA 작업이 없습니다.</div>';
  } catch (error) {
    elements.auditList.innerHTML = `<div class="empty-operations error">${escapeHtml(error.message)}</div>`;
  }
}

elements.categoryNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button || button.classList.contains("dba-only")) return;
  state.activeCategory = button.dataset.category;
  elements.categoryNav
    .querySelectorAll("[data-category]")
    .forEach((item) => item.classList.toggle("active", item === button));
  renderCategory();
});

elements.operationGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-operation-id]");
  if (!button) return;
  const item = [...state.viewerOperations, ...state.dbaOperations].find(
    (operation) => operation.id === button.dataset.operationId,
  );
  if (item) openOperation(item);
});

elements.scopeCluster.addEventListener("change", updateScope);
elements.scopeKeyspace.addEventListener("change", updateScope);
elements.scopeShard.addEventListener("change", updateScope);
elements.inventoryRefresh.addEventListener("click", loadInventory);
elements.auditRefresh.addEventListener("click", loadAudit);
elements.dbaButton.addEventListener("click", toggleDba);
elements.dbaForm.addEventListener("submit", enableDba);
elements.operationForm.addEventListener("submit", submitOperation);
elements.resultClear.addEventListener("click", () => {
  elements.resultTitle.textContent = "실행 결과";
  elements.resultMeta.textContent = "지워짐";
  elements.resultOutput.textContent =
    "Cluster와 작업 범위를 선택하고 기능을 실행하세요.";
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog")?.close());
});
for (const dialog of [elements.dbaDialog, elements.operationDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function initialize() {
  try {
    await loadCatalogs();
    await Promise.all([readSession(), loadInventory()]);
    renderCategory();
    if (location.hash === "#dba" && !state.dbaActive) {
      elements.dbaDialog.showModal();
      elements.dbaAck.focus();
    }
  } catch (error) {
    showStatus("error", "운영 콘솔 초기화 실패", error.message);
    showResult("초기화 실패", { error: error.message }, "VtAtlas");
  }
}

void initialize();
