const els = {
  refresh: document.querySelector("#error-refresh"),
  liveDot: document.querySelector("#error-live-dot"),
  clusterStatus: document.querySelector("#error-cluster-status"),
  lastCollected: document.querySelector("#error-last-collected"),
  statusBanner: document.querySelector("#error-status-banner"),
  list: document.querySelector("#error-list"),
  totalCount: document.querySelector("#total-error-count"),
  workflowCount: document.querySelector("#workflow-error-count"),
  sourceCount: document.querySelector("#source-error-count"),
  validationCount: document.querySelector("#validation-error-count"),
  rawDialog: document.querySelector("#error-raw-dialog"),
  rawTitle: document.querySelector("#error-raw-title"),
  rawContent: document.querySelector("#error-raw-content"),
  closeRaw: document.querySelector("#error-close-raw"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(iso) {
  if (!iso) return "수집 시각 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

function attributeRows(attributes, excluded = []) {
  return Object.entries(attributes ?? {})
    .filter(
      ([key, value]) =>
        value !== "" &&
        value !== undefined &&
        value !== null &&
        !excluded.includes(key),
    )
    .map(
      ([key, value]) => `
        <div>
          <dt>${escapeHtml(key)}</dt>
          <dd>${escapeHtml(String(value))}</dd>
        </div>`,
    )
    .join("");
}

function sourceButtons(sourceIds = []) {
  return sourceIds
    .map(
      (sourceId) => `
        <button class="error-source-button" type="button" data-source-id="${escapeHtml(sourceId)}">
          원본 응답 · ${escapeHtml(sourceId)} ↗
        </button>`,
    )
    .join("");
}

function workflowCard(node, collectedAt) {
  const message = node.attributes?.Message ?? "오류 메시지가 제공되지 않았습니다.";
  const detailUrl = `/?view=replication&select=${encodeURIComponent(node.id)}`;
  const degraded = node.status === "DEGRADED";
  return `
    <article class="error-card ${degraded ? "warning" : "critical"}">
      <header>
        <div>
          <span class="error-kind">VREPLICATION WORKFLOW</span>
          <h3>${escapeHtml(node.label)}</h3>
        </div>
        <span class="error-severity">${degraded ? "DEGRADED" : "ERROR"}</span>
      </header>
      <div class="error-message-block">
        <span>확인된 오류 메시지</span>
        <p>${escapeHtml(message)}</p>
      </div>
      <dl class="error-attribute-list">
        ${attributeRows(node.attributes, ["Message"])}
        <div><dt>Collected</dt><dd>${escapeHtml(formatTime(collectedAt))}</dd></div>
      </dl>
      <footer>
        <a class="error-graph-link" href="${detailUrl}">복제 관계에서 위치 보기 →</a>
        <div class="error-source-actions">${sourceButtons(node.sourceIds)}</div>
      </footer>
    </article>`;
}

function sourceErrorCard(error, source, collectedAt) {
  return `
    <article class="error-card">
      <header>
        <div>
          <span class="error-kind">DATA SOURCE</span>
          <h3>${escapeHtml(error.label ?? error.sourceId)}</h3>
        </div>
        <span class="error-severity">FAILED</span>
      </header>
      <div class="error-message-block">
        <span>수집 실패 메시지</span>
        <p>${escapeHtml(error.error ?? "오류 메시지가 제공되지 않았습니다.")}</p>
      </div>
      <dl class="error-attribute-list">
        <div><dt>Source ID</dt><dd>${escapeHtml(error.sourceId)}</dd></div>
        <div><dt>Command/Endpoint</dt><dd>${escapeHtml(source?.command ?? source?.endpoint ?? "N/A")}</dd></div>
        <div><dt>Collected</dt><dd>${escapeHtml(formatTime(source?.collectedAt ?? collectedAt))}</dd></div>
      </dl>
      <footer>
        <div class="error-source-actions">${sourceButtons([error.sourceId])}</div>
      </footer>
    </article>`;
}

function validationCard(issue, index, collectedAt) {
  return `
    <article class="error-card">
      <header>
        <div>
          <span class="error-kind">GRAPH VALIDATION</span>
          <h3>그래프 검증 문제 ${index + 1}</h3>
        </div>
        <span class="error-severity">INVALID</span>
      </header>
      <div class="error-message-block">
        <span>검증 결과</span>
        <p>${escapeHtml(typeof issue === "string" ? issue : JSON.stringify(issue))}</p>
      </div>
      <dl class="error-attribute-list">
        <div><dt>Collected</dt><dd>${escapeHtml(formatTime(collectedAt))}</dd></div>
      </dl>
    </article>`;
}

function render(data) {
  const workflowErrors = data.nodes.filter(
    (node) =>
      node.type === "workflow" &&
      ["ERROR", "DEGRADED"].includes(node.status),
  );
  const sourceErrors = data.errors ?? [];
  const validationErrors = data.validation?.issues ?? [];
  const total =
    workflowErrors.length + sourceErrors.length + validationErrors.length;

  els.totalCount.textContent = total;
  els.workflowCount.textContent = workflowErrors.length;
  els.sourceCount.textContent = sourceErrors.length;
  els.validationCount.textContent = validationErrors.length;
  els.lastCollected.textContent = `${formatTime(data.collectedAt)} · ${data.durationMs}ms`;

  const offline = data.overallStatus === "OFFLINE";
  const stale = data.cache?.stale;
  const critical =
    offline ||
    stale ||
    Boolean(data.cache?.degradedClusters?.length) ||
    data.nodes.some((node) =>
      ["CRITICAL", "ERROR", "UNREACHABLE", "OFFLINE"].includes(node.status),
    );
  els.liveDot.className = `live-dot ${
    critical ? "error" : total ? "" : "healthy"
  }`;
  els.clusterStatus.textContent = total
    ? `오류 ${total}개 확인`
    : "현재 확인된 오류 없음";

  if (offline) {
    els.statusBanner.className = "error-status-banner critical";
    els.statusBanner.textContent =
      "vtctld 연결이 끊어져 현재 토폴로지를 확인할 수 없습니다.";
  } else if (stale) {
    els.statusBanner.className = "error-status-banner warning";
    els.statusBanner.textContent = `${formatTime(data.cache.lastSuccessfulAt)}의 마지막 정상 데이터를 표시하고 있습니다.`;
  } else if (total) {
    els.statusBanner.className = `error-status-banner ${
      critical ? "critical" : "warning"
    }`;
    els.statusBanner.textContent =
      critical
        ? "서비스 영향 장애가 확인됐습니다. 아래 카드와 관계도의 빨간 연결을 확인하세요."
        : "성능 또는 복제 저하가 확인됐습니다. 서비스는 유지되지만 점검이 필요합니다.";
  } else {
    els.statusBanner.className = "error-status-banner healthy";
    els.statusBanner.textContent =
      "현재 수집 결과에서 Workflow, 데이터 소스, 그래프 검증 오류가 발견되지 않았습니다.";
  }

  const sourceById = new Map(
    data.sourceSummaries.map((source) => [source.id, source]),
  );
  const cards = [
    ...workflowErrors.map((node) => workflowCard(node, data.collectedAt)),
    ...sourceErrors.map((error) =>
      sourceErrorCard(
        error,
        sourceById.get(error.sourceId),
        data.collectedAt,
      ),
    ),
    ...validationErrors.map((issue, index) =>
      validationCard(issue, index, data.collectedAt),
    ),
  ];

  els.list.innerHTML = cards.length
    ? cards.join("")
    : `
      <div class="error-empty">
        <span>✓</span>
        <strong>현재 확인된 오류가 없습니다</strong>
        <p>자동 갱신으로 Workflow, 수집 소스와 그래프 검증 상태를 계속 확인합니다.</p>
      </div>`;

  els.list.querySelectorAll("[data-source-id]").forEach((button) => {
    button.addEventListener("click", () => openRaw(button.dataset.sourceId));
  });
}

async function openRaw(id) {
  els.rawTitle.textContent = id;
  els.rawContent.textContent = "원본 데이터를 불러오는 중…";
  els.rawDialog.showModal();
  try {
    const response = await fetch(`/api/raw/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    els.rawTitle.textContent = data.label ?? id;
    els.rawContent.textContent =
      typeof data.raw === "string"
        ? data.raw
        : JSON.stringify(data.raw, null, 2);
  } catch (error) {
    els.rawContent.textContent = `원본 데이터를 불러오지 못했습니다.\n${error.message}`;
  }
}

async function loadErrors(manual = false) {
  els.refresh.disabled = true;
  els.refresh.classList.add("loading");
  try {
    const response = await fetch(manual ? "/api/refresh" : "/api/topology", {
      method: manual ? "POST" : "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    els.liveDot.className = "live-dot error";
    els.clusterStatus.textContent = "오류 정보를 불러오지 못함";
    els.statusBanner.className = "error-status-banner critical";
    els.statusBanner.textContent = `뷰어 API 조회 실패: ${error.message}`;
    els.list.innerHTML = `
      <div class="error-loading failed">
        오류 정보 API에 연결할 수 없습니다. 관계도 화면의 상태도 함께 확인하세요.
      </div>`;
  } finally {
    els.refresh.disabled = false;
    els.refresh.classList.remove("loading");
  }
}

els.refresh.addEventListener("click", () => loadErrors(true));
els.closeRaw.addEventListener("click", () => els.rawDialog.close());

await loadErrors(false);
window.setInterval(() => loadErrors(false), 15000);
