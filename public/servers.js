const els = {
  liveDot: document.querySelector("#server-live-dot"),
  status: document.querySelector("#server-page-status"),
  count: document.querySelector("#server-count"),
  list: document.querySelector("#server-list"),
  notice: document.querySelector("#registry-notice"),
  editor: document.querySelector("#server-editor"),
  editorTitle: document.querySelector("#editor-title"),
  form: document.querySelector("#server-form"),
  message: document.querySelector("#form-message"),
  id: document.querySelector("#server-id"),
  name: document.querySelector("#server-name"),
  vtctldHttp: document.querySelector("#vtctld-http"),
  vtctldGrpc: document.querySelector("#vtctld-grpc"),
  vtgateHttp: document.querySelector("#vtgate-http"),
  vtgateGrpc: document.querySelector("#vtgate-grpc"),
  tabletTemplate: document.querySelector("#tablet-template"),
  enabled: document.querySelector("#server-enabled"),
};

let registry;
let topology;
let editingId = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function hostLines(cluster, component, field) {
  return (cluster.discovery?.[component] ?? [])
    .map((entry) => entry.host?.[field])
    .filter(Boolean);
}

function observedCluster(id) {
  return topology?.nodes?.find(
    (node) => node.type === "cluster" && node.attributes?.["Cluster ID"] === id,
  );
}

function render() {
  const clusters = [...(registry?.builtIn ?? []), ...(registry?.managed ?? [])];
  els.count.textContent = `${clusters.length}개 Cluster`;
  els.status.textContent = `등록 ${clusters.length}개 · 자동 재연결`;
  els.liveDot.classList.add("healthy");
  els.list.innerHTML = clusters
    .map((cluster) => {
      const observed = observedCluster(cluster.id);
      const endpointCount = Math.max(
        cluster.discovery?.vtctlds?.length ?? 0,
        cluster.discovery?.vtgates?.length ?? 0,
      );
      const focusHref = observed
        ? `/?view=logical&focus=${encodeURIComponent(observed.id)}`
        : "/";
      return `
        <article class="server-card ${cluster.enabled ? "" : "disabled"}">
          <header>
            <span class="server-kind">${cluster.builtIn ? "BUILT-IN" : "MANAGED"}</span>
            <span class="server-health ${observed ? "observed" : ""}">
              ${observed ? "관계도 수집됨" : cluster.enabled ? "연결 대기" : "수집 꺼짐"}
            </span>
          </header>
          <h3>${escapeHtml(cluster.name)}</h3>
          <p class="server-id">${escapeHtml(cluster.id)}</p>
          <dl>
            <div><dt>서버 수</dt><dd>${endpointCount}</dd></div>
            <div><dt>vtctld</dt><dd>${escapeHtml(hostLines(cluster, "vtctlds", "hostname").join(", "))}</dd></div>
            <div><dt>VTGate</dt><dd>${escapeHtml(hostLines(cluster, "vtgates", "hostname").join(", "))}</dd></div>
          </dl>
          <footer>
            <a class="secondary-button" href="${focusHref}">관계도에서 보기</a>
            ${
              cluster.builtIn
                ? '<span class="built-in-note">기본 Cluster</span>'
                : `<button class="secondary-button edit-server" data-id="${escapeHtml(cluster.id)}" type="button">수정</button>
                   <button class="danger-button remove-server" data-id="${escapeHtml(cluster.id)}" type="button">등록 해제</button>`
            }
          </footer>
        </article>`;
    })
    .join("");

  document.querySelectorAll(".edit-server").forEach((button) =>
    button.addEventListener("click", () => {
      const cluster = registry.managed.find((item) => item.id === button.dataset.id);
      openEditor(cluster);
    }),
  );
  document.querySelectorAll(".remove-server").forEach((button) =>
    button.addEventListener("click", () => removeServer(button.dataset.id)),
  );
}

function lines(value) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pairedHosts(httpValue, grpcValue, label) {
  const http = lines(httpValue);
  const grpc = lines(grpcValue);
  if (!http.length || http.length !== grpc.length) {
    throw new Error(`${label} HTTP와 gRPC 주소 개수를 같게 입력하세요.`);
  }
  return http.map((fqdn, index) => ({
    host: { fqdn, hostname: grpc[index] },
  }));
}

function formCluster() {
  return {
    id: els.id.value.trim(),
    name: els.name.value.trim(),
    enabled: els.enabled.checked,
    tabletFqdnTemplate: els.tabletTemplate.value.trim(),
    discovery: {
      vtctlds: pairedHosts(
        els.vtctldHttp.value,
        els.vtctldGrpc.value,
        "vtctld",
      ),
      vtgates: pairedHosts(
        els.vtgateHttp.value,
        els.vtgateGrpc.value,
        "VTGate",
      ),
    },
  };
}

function openEditor(cluster = null) {
  editingId = cluster?.id ?? null;
  els.editorTitle.textContent = cluster ? `${cluster.name} 수정` : "새 서버 등록";
  els.id.value = cluster?.id ?? "";
  els.id.disabled = Boolean(cluster);
  els.name.value = cluster?.name ?? "";
  els.vtctldHttp.value = cluster
    ? hostLines(cluster, "vtctlds", "fqdn").join("\n")
    : "";
  els.vtctldGrpc.value = cluster
    ? hostLines(cluster, "vtctlds", "hostname").join("\n")
    : "";
  els.vtgateHttp.value = cluster
    ? hostLines(cluster, "vtgates", "fqdn").join("\n")
    : "";
  els.vtgateGrpc.value = cluster
    ? hostLines(cluster, "vtgates", "hostname").join("\n")
    : "";
  els.tabletTemplate.value =
    cluster?.tabletFqdnTemplate ??
    "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}";
  els.enabled.checked = cluster?.enabled !== false;
  els.message.textContent = "";
  els.message.className = "form-message";
  els.editor.classList.remove("hidden");
  els.editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditor() {
  editingId = null;
  els.editor.classList.add("hidden");
  els.form.reset();
  els.id.disabled = false;
}

async function apiMutation(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Vitess-Topology-Intent": "manage-servers",
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

async function load() {
  try {
    const [registryResponse, topologyResponse] = await Promise.all([
      fetch("/api/servers", { headers: { Accept: "application/json" } }),
      fetch("/api/topology", { headers: { Accept: "application/json" } }),
    ]);
    if (!registryResponse.ok || !topologyResponse.ok) throw new Error("API 조회 실패");
    [registry, topology] = await Promise.all([
      registryResponse.json(),
      topologyResponse.json(),
    ]);
    render();
  } catch (error) {
    els.status.textContent = "서버 등록 정보를 불러오지 못함";
    els.notice.textContent = error.message;
    els.notice.classList.add("error");
  }
}

async function removeServer(id) {
  const cluster = registry.managed.find((item) => item.id === id);
  if (!cluster || !window.confirm(`${cluster.name} 모니터링 등록을 해제할까요?`)) return;
  try {
    await apiMutation(`/api/servers/${encodeURIComponent(id)}`, "DELETE");
    els.notice.textContent = `${cluster.name} 등록을 해제했습니다. VTAdmin이 자동으로 다시 시작됩니다.`;
    await load();
  } catch (error) {
    els.notice.textContent = error.message;
    els.notice.classList.add("error");
  }
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const cluster = formCluster();
    els.message.textContent = "저장 중…";
    await apiMutation(
      editingId
        ? `/api/servers/${encodeURIComponent(editingId)}`
        : "/api/servers",
      editingId ? "PUT" : "POST",
      cluster,
    );
    els.notice.classList.remove("error");
    els.notice.textContent = `${cluster.name} 설정을 저장했습니다. VTAdmin 재연결 후 관계도에 자동 반영됩니다.`;
    closeEditor();
    await load();
    window.setTimeout(() => {
      void fetch("/api/refresh", { method: "POST" }).then(() => load());
    }, 7000);
  } catch (error) {
    els.message.textContent = error.message;
    els.message.className = "form-message error";
  }
});

document.querySelector("#new-server").addEventListener("click", () => openEditor());
document.querySelector("#close-editor").addEventListener("click", closeEditor);
document.querySelector("#cancel-editor").addEventListener("click", closeEditor);

await load();
