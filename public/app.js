const NODE_WIDTH = 264;
const NODE_HEIGHT = 138;
const NODE_GAP = 38;
const LEVEL_GAP = 88;
const MAX_NODES_PER_ROW = 4;

const state = {
  topology: null,
  view: "logical",
  selectedId: null,
  focusId: null,
  focusTrail: [],
  collapsed: new Set(),
  transform: { x: 70, y: 55, scale: 1 },
  positions: new Map(),
  refreshTimer: null,
  dragging: null,
  historyTransition: false,
};

const initialParams = new URLSearchParams(window.location.search);
const requestedView = initialParams.get("view");
if (["logical", "physical", "request", "replication"].includes(requestedView)) {
  state.view = requestedView;
}
const requestedSelection = initialParams.get("select");
const requestedFocus = initialParams.get("focus");

const els = {
  viewport: document.querySelector("#graph-viewport"),
  world: document.querySelector("#graph-world"),
  nodes: document.querySelector("#node-layer"),
  edges: document.querySelector("#edge-layer"),
  template: document.querySelector("#node-template"),
  empty: document.querySelector("#empty-state"),
  detail: document.querySelector("#detail-panel"),
  detailContent: document.querySelector("#detail-content"),
  closeDetail: document.querySelector("#close-detail"),
  rawDialog: document.querySelector("#raw-dialog"),
  rawTitle: document.querySelector("#raw-title"),
  rawContent: document.querySelector("#raw-content"),
  closeRaw: document.querySelector("#close-raw"),
  refresh: document.querySelector("#refresh-button"),
  refreshRate: document.querySelector("#refresh-rate"),
  liveDot: document.querySelector("#live-dot"),
  clusterStatus: document.querySelector("#cluster-status"),
  lastCollected: document.querySelector("#last-collected"),
  notice: document.querySelector("#notice"),
  noticeMessage: document.querySelector("#notice-message"),
  noticeAction: document.querySelector("#notice-action"),
  headerErrorCount: document.querySelector("#header-error-count"),
  errorPageLink: document.querySelector("#error-page-link"),
  search: document.querySelector("#search"),
  cell: document.querySelector("#filter-cell"),
  keyspace: document.querySelector("#filter-keyspace"),
  shard: document.querySelector("#filter-shard"),
  tabletType: document.querySelector("#filter-tablet-type"),
  resetFilters: document.querySelector("#reset-filters"),
  sourceToggle: document.querySelector("#source-toggle"),
  sourceList: document.querySelector("#source-list"),
  sourceSummary: document.querySelector("#source-summary"),
  zoomLabel: document.querySelector("#zoom-label"),
  viewKicker: document.querySelector("#view-kicker"),
  viewTitle: document.querySelector("#view-title"),
  viewDescription: document.querySelector("#view-description"),
  focusChip: document.querySelector("#focus-chip"),
  focusLabel: document.querySelector("#focus-label"),
  focusBack: document.querySelector("#focus-back"),
  focusReset: document.querySelector("#focus-reset"),
  typeLegend: document.querySelector("#type-legend"),
};

const viewCopy = {
  logical: {
    kicker: "LOGICAL TOPOLOGY",
    title: "Keyspace에서 Tablet까지",
    description: "공식 vtctld API가 확인한 소속과 Primary 관계만 표시합니다.",
  },
  physical: {
    kicker: "PHYSICAL TOPOLOGY",
    title: "Host에서 MySQL까지",
    description: "Host → Cluster → Service/Cell → vttablet → Tablet → MySQL 순서입니다.",
  },
  request: {
    kicker: "REQUEST PATH",
    title: "VTGate에서 Serving Tablet까지",
    description: "VTGate → Serving Graph → Keyspace → Shard → Tablet 순서입니다.",
  },
  replication: {
    kicker: "REPLICATION VIEW",
    title: "Workflow와 Primary 복제 역할",
    description: "Workflow 아래 Source/Target Keyspace를 나란히 두고 각 복제 트리를 분리합니다.",
  },
};

const iconByType = {
  cluster: "VT",
  host: "H",
  topologyService: "T",
  controlPlane: "C",
  gateway: "G",
  tabletProcess: "P",
  orchestrator: "O",
  admin: "A",
  cell: "CL",
  keyspace: "K",
  vschema: "VS",
  shard: "S",
  tablet: "TB",
  mysql: "MY",
  servingGraph: "SG",
  workflow: "WF",
};

const labelByType = {
  cluster: "Vitess Cluster",
  host: "Host",
  topologyService: "Topology Service",
  controlPlane: "vtctld",
  gateway: "VTGate",
  tabletProcess: "vttablet process",
  orchestrator: "VTOrc",
  admin: "VTAdmin",
  cell: "Cell",
  keyspace: "Keyspace",
  vschema: "VSchema",
  shard: "Shard",
  tablet: "Tablet",
  mysql: "MySQL",
  servingGraph: "Serving Graph",
  workflow: "VReplication",
};

const rankByView = {
  logical: {
    cluster: 0,
    keyspace: 1,
    shard: 2,
    tablet: 3,
  },
  physical: {
    host: 0,
    cluster: 1,
    topologyService: 2,
    controlPlane: 2,
    gateway: 2,
    orchestrator: 2,
    admin: 2,
    cell: 2,
    tabletProcess: 3,
    mysql: 5,
    tablet: 4,
  },
  request: {
    gateway: 0,
    servingGraph: 1,
    keyspace: 2,
    shard: 3,
    tablet: 4,
  },
  replication: {
    workflow: 0,
    keyspace: 1,
    shard: 2,
    tablet: 3,
  },
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

function isUnsharded(node) {
  return String(node?.attributes?.Sharding ?? "").startsWith("UNSHARDED");
}

function healthLevel(status) {
  const normalized = String(status ?? "UNKNOWN").toUpperCase();
  if (["CRITICAL", "ERROR", "UNREACHABLE", "OFFLINE"].includes(normalized)) {
    return "critical";
  }
  if (["DEGRADED", "WARNING"].includes(normalized)) return "degraded";
  if (["UNKNOWN", "MAINTENANCE", "NOT_RUNNING", "STALE"].includes(normalized)) {
    return "unknown";
  }
  return "healthy";
}

function isUnshardedKeyspace(keyspace, clusterId) {
  return state.topology?.nodes.some(
    (node) =>
      node.type === "keyspace" &&
      node.label === keyspace &&
      (!clusterId || node.attributes?.["Cluster ID"] === clusterId) &&
      isUnsharded(node),
  );
}

function normalizeFocusId(id) {
  const node = state.topology?.nodes.find((item) => item.id === id);
  if (node?.type !== "shard" || !isUnsharded(node)) return id;
  const parent = state.topology?.edges.find(
    (edge) =>
      edge.target === node.id &&
      state.topology?.nodes.some(
        (candidate) =>
          candidate.id === edge.source && candidate.type === "keyspace",
      ),
  );
  return parent?.source ?? id;
}

function setOptions(select, values, current, labeler = (value) => value) {
  const options = [
    '<option value="">전체</option>',
    ...[...new Set(values)]
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map(
        (value) =>
          `<option value="${escapeHtml(value)}">${escapeHtml(labeler(value))}</option>`,
      ),
  ];
  select.innerHTML = options.join("");
  select.value = values.includes(current) ? current : "";
}

function updateFilters() {
  const topology = state.topology;
  if (!topology) return;
  const current = {
    cell: els.cell.value,
    keyspace: els.keyspace.value,
    shard: els.shard.value,
    tabletType: els.tabletType.value,
  };
  const tablets = topology.nodes.filter((node) => node.type === "tablet");
  setOptions(
    els.cell,
    [
      ...topology.nodes
        .filter((node) => node.type === "cell")
        .map((node) => node.label),
      ...tablets.map((node) => node.attributes.Cell),
    ],
    current.cell,
  );
  setOptions(
    els.keyspace,
    topology.nodes
      .filter((node) => node.type === "keyspace")
      .map((node) => node.label),
    current.keyspace,
  );
  const shardNodes = topology.nodes.filter(
    (node) => node.type === "shard" && !isUnsharded(node),
  );
  setOptions(
    els.shard,
    shardNodes.map((node) => node.attributes.Shard),
    current.shard,
  );
  setOptions(
    els.tabletType,
    tablets.map((node) => node.attributes["Tablet type"]),
    current.tabletType,
  );
}

function nodeMatchesFilters(node) {
  const filters = {
    Cell: els.cell.value,
    Keyspace: els.keyspace.value,
    Shard: els.shard.value,
    "Tablet type": els.tabletType.value,
  };
  return Object.entries(filters).every(
    ([key, value]) => !value || node.attributes?.[key] === value,
  );
}

function hiddenByCollapse(edges) {
  const hidden = new Set();
  const outgoing = new Map();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const visit = (id, trail = new Set()) => {
    if (trail.has(id)) return;
    trail.add(id);
    for (const child of outgoing.get(id) ?? []) {
      hidden.add(child);
      visit(child, new Set(trail));
    }
  };
  for (const id of state.collapsed) visit(id);
  return hidden;
}

function projectUnshardedShards(nodes, edges) {
  const hiddenShards = nodes.filter(
    (node) => node.type === "shard" && isUnsharded(node),
  );
  if (!hiddenShards.length) return { nodes, edges };

  const hiddenIds = new Set(hiddenShards.map((node) => node.id));
  const projectedEdges = edges.filter(
    (edge) => !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target),
  );
  const edgeKeys = new Set(
    projectedEdges.map(
      (edge) => `${edge.source}\u0000${edge.target}\u0000${edge.label ?? ""}`,
    ),
  );

  for (const shard of hiddenShards) {
    const incoming = edges.filter((edge) => edge.target === shard.id);
    const outgoing = edges.filter((edge) => edge.source === shard.id);
    for (const parent of incoming) {
      for (const child of outgoing) {
        if (parent.source === child.target) continue;
        const label =
          state.view === "logical"
            ? `노샤딩 · ${child.label || "Tablet"}`
            : child.label;
        const key = `${parent.source}\u0000${child.target}\u0000${label ?? ""}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        projectedEdges.push({
          id: `presentation:unsharded:${state.view}:${parent.source}:${child.target}`,
          source: parent.source,
          target: child.target,
          type: "unsharded-direct",
          label,
          confidence:
            parent.confidence === "CONFIRMED" &&
            child.confidence === "CONFIRMED"
              ? "CONFIRMED"
              : "DERIVED",
          views: [state.view],
          presentationOnly: true,
        });
      }
    }
  }

  return {
    nodes: nodes.filter((node) => !hiddenIds.has(node.id)),
    edges: projectedEdges,
  };
}

function projectPhysicalHierarchy(nodes, edges) {
  if (state.view !== "physical") return { nodes, edges };
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const projectedEdges = edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return false;
    if (
      source.type === "cluster" &&
      (target.type === "tabletProcess" ||
        (target.type === "mysql" && target.id.startsWith("process:mysqld:")))
    ) {
      return false;
    }
    if (
      source.type === "cell" &&
      target.type === "tablet" &&
      edges.some(
        (candidate) =>
          candidate.type === "represents" && candidate.target === target.id,
      )
    ) {
      return false;
    }
    return true;
  });

  const edgeKeys = new Set(
    projectedEdges.map((edge) => `${edge.source}\u0000${edge.target}`),
  );
  for (const runtimeEdge of edges.filter(
    (edge) => edge.type === "represents",
  )) {
    const cellEdge = edges.find(
      (edge) =>
        edge.type === "member-of-cell" &&
        edge.target === runtimeEdge.target,
    );
    if (!cellEdge) continue;
    const key = `${cellEdge.source}\u0000${runtimeEdge.source}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    projectedEdges.push({
      id: `presentation:physical:${cellEdge.source}:${runtimeEdge.source}`,
      source: cellEdge.source,
      target: runtimeEdge.source,
      type: "cell-runtime",
      label: "vttablet runtime",
      confidence:
        cellEdge.confidence === "CONFIRMED" &&
        runtimeEdge.confidence === "CONFIRMED"
          ? "CONFIRMED"
          : "DERIVED",
      views: ["physical"],
      presentationOnly: true,
    });
  }
  return { nodes, edges: projectedEdges };
}

function visibleGraph() {
  if (!state.topology) return { nodes: [], edges: [] };
  const ranks = rankByView[state.view];
  const allowedTypes = new Set(Object.keys(ranks));
  let nodes = state.topology.nodes.filter((node) => allowedTypes.has(node.type));
  let nodeIds = new Set(nodes.map((node) => node.id));
  let edges = state.topology.edges.filter(
    (edge) =>
      edge.views?.includes(state.view) &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target),
  );
  ({ nodes, edges } = projectPhysicalHierarchy(nodes, edges));
  ({ nodes, edges } = projectUnshardedShards(nodes, edges));
  nodeIds = new Set(nodes.map((node) => node.id));

  const hasFilter =
    !state.focusId &&
    (els.cell.value ||
      els.keyspace.value ||
      els.shard.value ||
      els.tabletType.value);
  if (hasFilter) {
    const matches = new Set(nodes.filter(nodeMatchesFilters).map((node) => node.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (matches.has(edge.target) && !matches.has(edge.source)) {
          matches.add(edge.source);
          changed = true;
        }
      }
    }
    nodes = nodes.filter((node) => matches.has(node.id));
    nodeIds = new Set(nodes.map((node) => node.id));
    edges = edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
    );
  }

  const focusId = normalizeFocusId(state.focusId);
  if (focusId && nodeIds.has(focusId)) {
    const focused = focusedNodeIds(focusId, edges);
    nodes = nodes.filter((node) => focused.has(node.id));
    nodeIds = new Set(nodes.map((node) => node.id));
    edges = edges.filter(
      (edge) =>
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target) &&
        (edge.source === focusId || edge.target === focusId),
    );
  }

  const hidden = hiddenByCollapse(edges);
  nodes = nodes.filter((node) => !hidden.has(node.id));
  nodeIds = new Set(nodes.map((node) => node.id));
  edges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return { nodes, edges };
}

function focusedNodeIds(rootId, edges) {
  const focused = new Set([rootId]);
  for (const edge of edges) {
    if (edge.source === rootId) focused.add(edge.target);
    if (edge.target === rootId) focused.add(edge.source);
  }
  return focused;
}

function nodeRank(node) {
  if (
    state.view === "physical" &&
    node.id === "installed:mysqlctld"
  ) {
    return 2;
  }
  if (
    state.view === "request" &&
    node.type === "tablet" &&
    isUnshardedKeyspace(
      node.attributes?.Keyspace,
      node.attributes?.["Cluster ID"],
    )
  ) {
    return 3;
  }
  if (state.view === "replication" && node.type === "tablet") {
    if (
      node.attributes?.["Tablet type"] === "PRIMARY" &&
      isUnshardedKeyspace(
        node.attributes?.Keyspace,
        node.attributes?.["Cluster ID"],
      )
    ) {
      return 2;
    }
    return 3;
  }
  return rankByView[state.view][node.type] ?? 5;
}

function layout(nodes, edges) {
  if (state.view === "logical") {
    layoutLogical(nodes, edges);
    return;
  }
  if (state.view === "replication") {
    layoutReplication(nodes, edges);
    return;
  }
  if (state.view === "request") {
    layoutRequest(nodes, edges);
    return;
  }
  layoutStrictLevels(nodes, edges);
}

function semanticNodeKey(node, edges) {
  if (state.view === "physical") {
    const typeOrder = {
      topologyService: 0,
      controlPlane: 1,
      gateway: 2,
      cell: 3,
      orchestrator: 4,
      admin: 5,
      mysql: 6,
    };
    return `${String(typeOrder[node.type] ?? 9).padStart(2, "0")}:${node.attributes?.Keyspace ?? ""}:${node.attributes?.Shard ?? ""}:${node.label}`;
  }
  if (state.view === "replication" && node.type === "keyspace") {
    const relationship = edges.find(
      (edge) => edge.target === node.id && edge.source.startsWith("workflow:"),
    )?.label;
    const roleOrder = relationship === "SOURCE" ? 0 : relationship === "TARGET" ? 1 : 2;
    return `${roleOrder}:${node.label}`;
  }
  return `${node.attributes?.["Cluster ID"] ?? ""}:${node.attributes?.Keyspace ?? ""}:${node.attributes?.Shard ?? ""}:${node.attributes?.["Tablet type"] ?? ""}:${node.label}`;
}

function relatedNodes(parentId, type, nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.source === parentId)
    .map((edge) => nodeById.get(edge.target))
    .filter((node) => node?.type === type);
}

function keyspaceLane(keyspace, nodes, edges) {
  const shards = relatedNodes(keyspace.id, "shard", nodes, edges).sort((a, b) =>
    String(a.attributes?.Shard).localeCompare(String(b.attributes?.Shard)),
  );
  const tablets = [
    ...new Map(
      [
        ...relatedNodes(keyspace.id, "tablet", nodes, edges),
        ...shards.flatMap((shard) =>
          relatedNodes(shard.id, "tablet", nodes, edges),
        ),
      ]
        .map((tablet) => [tablet.id, tablet]),
    ).values(),
  ].sort((a, b) =>
    `${a.attributes?.Shard}:${a.attributes?.["Tablet type"]}:${a.label}`.localeCompare(
      `${b.attributes?.Shard}:${b.attributes?.["Tablet type"]}:${b.label}`,
    ),
  );
  const width = Math.max(
    NODE_WIDTH,
    widthForCount(shards.length, 3),
    widthForCount(tablets.length, 3),
  );
  return { keyspace, shards, tablets, width };
}

function layoutStrictLevels(nodes, edges, verticalGap = 58) {
  const levels = new Map();
  for (const node of nodes) {
    const rank = nodeRank(node);
    const list = levels.get(rank) ?? [];
    list.push(node);
    levels.set(rank, list);
  }
  const sortedLevels = [...levels.entries()].sort(([a], [b]) => a - b);
  const widestCount = Math.max(1, ...sortedLevels.map(([, level]) => level.length));
  const canvasWidth =
    widestCount * NODE_WIDTH + Math.max(0, widestCount - 1) * NODE_GAP;
  const positions = new Map();
  const orderIndex = new Map();
  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  let y = 48;
  for (const [, levelNodes] of sortedLevels) {
    levelNodes.sort((a, b) => {
      const parentAverage = (node) => {
        const values = (incoming.get(node.id) ?? [])
          .map((id) => orderIndex.get(id))
          .filter((value) => value !== undefined);
        return values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : Number.POSITIVE_INFINITY;
      };
      const parentDiff = parentAverage(a) - parentAverage(b);
      if (Number.isFinite(parentDiff) && parentDiff !== 0) return parentDiff;
      const aKey = semanticNodeKey(a, edges);
      const bKey = semanticNodeKey(b, edges);
      return aKey.localeCompare(bKey);
    });
    const rowWidth =
      levelNodes.length * NODE_WIDTH +
      Math.max(0, levelNodes.length - 1) * NODE_GAP;
    const startX = 48 + (canvasWidth - rowWidth) / 2;
    levelNodes.forEach((node, index) => {
      positions.set(node.id, {
        x: startX + index * (NODE_WIDTH + NODE_GAP),
        y,
      });
      orderIndex.set(node.id, index);
    });
    y += NODE_HEIGHT + verticalGap;
  }
  state.positions = positions;
}

function layoutRequest(nodes, edges) {
  const keyspaces = nodes
    .filter((node) => node.type === "keyspace")
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!keyspaces.length) {
    layoutStrictLevels(nodes, edges);
    return;
  }
  const lanes = keyspaces.map((keyspace) => {
    const base = keyspaceLane(keyspace, nodes, edges);
    const servings = edges
      .filter((edge) => edge.target === keyspace.id)
      .map((edge) => nodes.find((node) => node.id === edge.source))
      .filter((node) => node?.type === "servingGraph");
    const { shards, tablets } = base;
    const width = Math.max(
      NODE_WIDTH,
      widthForCount(servings.length, 3),
      widthForCount(shards.length, 3),
      widthForCount(tablets.length, 3),
    );
    return { keyspace, servings, shards, tablets, width };
  });
  const laneGap = 82;
  const totalWidth =
    lanes.reduce((sum, lane) => sum + lane.width, 0) +
    Math.max(0, lanes.length - 1) * laneGap;
  const positions = new Map();
  const gateways = nodes
    .filter((node) => node.type === "gateway")
    .sort((a, b) => a.label.localeCompare(b.label));
  const gatewayY = 44;
  const servingY = gateways.length ? gatewayY + NODE_HEIGHT + 68 : gatewayY;
  const servingRows = Math.max(
    1,
    ...lanes.map((lane) => Math.ceil(lane.servings.length / 3)),
  );
  const keyspaceY =
    servingY + servingRows * (NODE_HEIGHT + NODE_GAP) + 68 - NODE_GAP;
  const branchY = keyspaceY + NODE_HEIGHT + 68;
  let laneX = 48;
  for (const lane of lanes) {
    placeCenteredRows(
      positions,
      lane.servings,
      laneX,
      lane.width,
      servingY,
      3,
    );
    positions.set(lane.keyspace.id, {
      x: laneX + (lane.width - NODE_WIDTH) / 2,
      y: keyspaceY,
    });
    placeCenteredRows(positions, lane.shards, laneX, lane.width, branchY, 3);
    const tabletY = lane.shards.length
      ? branchY +
        Math.ceil(lane.shards.length / 3) * (NODE_HEIGHT + NODE_GAP) +
        68 -
        NODE_GAP
      : branchY;
    placeCenteredRows(positions, lane.tablets, laneX, lane.width, tabletY, 3);
    laneX += lane.width + laneGap;
  }
  for (const gateway of gateways) {
    const servingIds = new Set(
      edges
        .filter((edge) => edge.source === gateway.id)
        .map((edge) => edge.target),
    );
    const keyspaceIds = edges
      .filter((edge) => servingIds.has(edge.source))
      .map((edge) => edge.target);
    const keyspacePositions = keyspaceIds
      .map((id) => positions.get(id))
      .filter(Boolean);
    if (keyspacePositions.length) {
      const left = Math.min(...keyspacePositions.map((position) => position.x));
      const right = Math.max(
        ...keyspacePositions.map((position) => position.x + NODE_WIDTH),
      );
      positions.set(gateway.id, {
        x: (left + right - NODE_WIDTH) / 2,
        y: gatewayY,
      });
    }
  }
  const unpositionedGateways = gateways.filter(
    (gateway) => !positions.has(gateway.id),
  );
  placeCenteredRows(
    positions,
    unpositionedGateways,
    48,
    totalWidth,
    gatewayY,
    3,
  );
  state.positions = positions;
}

function layoutReplication(nodes, edges) {
  const keyspaces = nodes
    .filter((node) => node.type === "keyspace")
    .sort((a, b) => semanticNodeKey(a, edges).localeCompare(semanticNodeKey(b, edges)));
  if (!keyspaces.length) {
    layoutStrictLevels(nodes, edges);
    return;
  }
  const lanes = keyspaces.map((keyspace) => {
    const base = keyspaceLane(keyspace, nodes, edges);
    const { shards } = base;
    const primaries = base.tablets
      .filter((node) => node.attributes?.["Tablet type"] === "PRIMARY")
      .sort((a, b) => `${a.attributes?.Shard}:${a.label}`.localeCompare(`${b.attributes?.Shard}:${b.label}`));
    const replicas = base.tablets
      .filter((node) => node.attributes?.["Tablet type"] !== "PRIMARY")
      .sort((a, b) => a.label.localeCompare(b.label));
    const width = Math.max(
      NODE_WIDTH,
      widthForCount(shards.length, 3),
      widthForCount(primaries.length, 3),
      widthForCount(replicas.length, 3),
    );
    return { keyspace, shards, primaries, replicas, width };
  });
  const laneGap = 82;
  const totalWidth =
    lanes.reduce((sum, lane) => sum + lane.width, 0) +
    Math.max(0, lanes.length - 1) * laneGap;
  const positions = new Map();
  const workflows = nodes
    .filter((node) => node.type === "workflow")
    .sort((a, b) => a.label.localeCompare(b.label));
  const workflowY = 44;
  const keyspaceY = workflows.length
    ? workflowY + NODE_HEIGHT + 68
    : workflowY;
  const branchY = keyspaceY + NODE_HEIGHT + 68;
  const leafY = branchY + NODE_HEIGHT + 68;
  let laneX = 48;
  for (const lane of lanes) {
    positions.set(lane.keyspace.id, {
      x: laneX + (lane.width - NODE_WIDTH) / 2,
      y: keyspaceY,
    });
    if (lane.shards.length) {
      placeCenteredRows(positions, lane.shards, laneX, lane.width, branchY, 3);
      placeCenteredRows(positions, lane.primaries, laneX, lane.width, leafY, 3);
      placeCenteredRows(
        positions,
        lane.replicas,
        laneX,
        lane.width,
        leafY + NODE_HEIGHT + 68,
        3,
      );
    } else {
      placeCenteredRows(positions, lane.primaries, laneX, lane.width, branchY, 3);
      placeCenteredRows(positions, lane.replicas, laneX, lane.width, leafY, 3);
    }
    laneX += lane.width + laneGap;
  }
  for (const workflow of workflows) {
    const keyspacePositions = edges
      .filter((edge) => edge.source === workflow.id)
      .map((edge) => positions.get(edge.target))
      .filter(Boolean);
    if (!keyspacePositions.length) continue;
    const left = Math.min(...keyspacePositions.map((position) => position.x));
    const right = Math.max(
      ...keyspacePositions.map((position) => position.x + NODE_WIDTH),
    );
    positions.set(workflow.id, {
      x: (left + right - NODE_WIDTH) / 2,
      y: workflowY,
    });
  }
  placeCenteredRows(
    positions,
    workflows.filter((workflow) => !positions.has(workflow.id)),
    48,
    totalWidth,
    workflowY,
    3,
  );
  state.positions = positions;
}

function widthForCount(count, maxPerRow = MAX_NODES_PER_ROW) {
  const visibleCount = Math.max(1, Math.min(count, maxPerRow));
  return visibleCount * NODE_WIDTH + (visibleCount - 1) * NODE_GAP;
}

function placeCenteredRows(positions, items, laneX, laneWidth, startY, maxPerRow = 3) {
  let y = startY;
  for (let index = 0; index < items.length; index += maxPerRow) {
    const row = items.slice(index, index + maxPerRow);
    const rowWidth = widthForCount(row.length, maxPerRow);
    const startX = laneX + (laneWidth - rowWidth) / 2;
    row.forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: startX + rowIndex * (NODE_WIDTH + NODE_GAP),
        y,
      });
    });
    y += NODE_HEIGHT + NODE_GAP;
  }
  return y;
}

function layoutLogical(nodes, edges) {
  const positions = new Map();
  const clusters = nodes
    .filter((node) => node.type === "cluster")
    .sort((a, b) => a.label.localeCompare(b.label));
  const keyspaces = nodes
    .filter((node) => node.type === "keyspace")
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!keyspaces.length) {
    layoutStrictLevels(nodes, edges);
    return;
  }
  const claimed = new Set();
  const groups = clusters.map((cluster) => {
    const lanes = relatedNodes(cluster.id, "keyspace", nodes, edges).map(
      (keyspace) => {
        claimed.add(keyspace.id);
        return keyspaceLane(keyspace, nodes, edges);
      },
    );
    const width = Math.max(
      NODE_WIDTH,
      lanes.reduce((sum, lane) => sum + lane.width, 0) +
        Math.max(0, lanes.length - 1) * 82,
    );
    return { cluster, lanes, width };
  });
  const orphanLanes = keyspaces
    .filter((keyspace) => !claimed.has(keyspace.id))
    .map((keyspace) => keyspaceLane(keyspace, nodes, edges));
  if (orphanLanes.length) {
    groups.push({
      cluster: null,
      lanes: orphanLanes,
      width:
        orphanLanes.reduce((sum, lane) => sum + lane.width, 0) +
        Math.max(0, orphanLanes.length - 1) * 82,
    });
  }
  const laneGap = 82;
  const totalWidth =
    groups.reduce((sum, group) => sum + group.width, 0) +
    Math.max(0, groups.length - 1) * 118;
  let groupX = 48;
  const clusterY = 44;
  const keyspaceY = clusterY + NODE_HEIGHT + LEVEL_GAP;
  const shardY = keyspaceY + NODE_HEIGHT + LEVEL_GAP;
  for (const group of groups) {
    if (group.cluster) {
      positions.set(group.cluster.id, {
        x: groupX + (group.width - NODE_WIDTH) / 2,
        y: clusterY,
      });
    }
    let laneX = groupX;
    for (const lane of group.lanes) {
      positions.set(lane.keyspace.id, {
        x: laneX + (lane.width - NODE_WIDTH) / 2,
        y: group.cluster ? keyspaceY : clusterY,
      });
      const laneShardY = group.cluster ? shardY : keyspaceY;
      placeCenteredRows(positions, lane.shards, laneX, lane.width, laneShardY, 3);
      const tabletY = lane.shards.length
        ? laneShardY +
          Math.ceil(lane.shards.length / 3) * (NODE_HEIGHT + NODE_GAP) +
          LEVEL_GAP -
          NODE_GAP
        : laneShardY;
      placeCenteredRows(positions, lane.tablets, laneX, lane.width, tabletY, 3);
      laneX += lane.width + laneGap;
    }
    groupX += group.width + 118;
  }
  state.positions = positions;
}

function metaForNode(node) {
  const attrs = node.attributes ?? {};
  const candidates = [
    attrs.Failure && `연결 실패 · ${attrs.Failure}`,
    healthLevel(node.status) === "critical" &&
      "서비스 영향 · 즉시 확인 필요",
    healthLevel(node.status) === "degraded" &&
      "성능 저하 또는 Replica/복제 장애",
    healthLevel(node.status) === "unknown" &&
      "확인 불가 또는 Maintenance",
    node.type === "shard" &&
      String(attrs.Sharding).startsWith("UNSHARDED") &&
      "topology shard 0 · 단일 파티션",
    node.type === "keyspace" && attrs.Sharding,
    attrs["Tablet type"] &&
      (isUnshardedKeyspace(attrs.Keyspace, attrs["Cluster ID"])
        ? `${attrs["Tablet type"]} · ${attrs.Keyspace} · 노샤딩`
        : `${attrs["Tablet type"]} · ${attrs.Keyspace}/${attrs.Shard}`),
    attrs["Key range"] && `range ${attrs["Key range"]}`,
    attrs.Cell && `cell ${attrs.Cell}`,
    attrs.Version && `version ${attrs.Version}`,
    attrs.PID && `pid ${attrs.PID}`,
    attrs.Type && `${attrs.Type} · ${attrs.State}`,
  ].filter(Boolean);
  return candidates[0] ?? labelByType[node.type] ?? node.type;
}

function renderNodes(nodes, edges) {
  els.nodes.replaceChildren();
  const outgoing = new Set(edges.map((edge) => edge.source));
  const query = els.search.value.trim().toLowerCase();
  for (const node of nodes) {
    const fragment = els.template.content.cloneNode(true);
    const card = fragment.querySelector(".graph-node");
    const position = state.positions.get(node.id);
    card.dataset.id = node.id;
    card.dataset.type = node.type;
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
    card.classList.toggle("selected", node.id === state.selectedId);
    card.classList.toggle("focus-root", node.id === normalizeFocusId(state.focusId));
    card.classList.toggle(
      "keyspace-unsharded",
      node.type === "keyspace" && isUnsharded(node),
    );
    const status = String(node.status ?? "UNKNOWN").toLowerCase();
    card.classList.add(`status-${status}`);
    const haystack = JSON.stringify(node).toLowerCase();
    card.classList.toggle("search-match", Boolean(query && haystack.includes(query)));
    card.querySelector(".node-icon").textContent = iconByType[node.type] ?? "•";
    card.querySelector(".node-type").textContent = labelByType[node.type] ?? node.type;
    card.querySelector(".node-label").textContent = node.label;
    card.querySelector(".node-meta").textContent = metaForNode(node);
    const level = healthLevel(node.status);
    const statusPrefix = {
      critical: "⚠",
      degraded: "△",
      unknown: "?",
      healthy: "✓",
    }[level];
    card.querySelector(".state-badge").textContent =
      `${statusPrefix} ${node.status ?? "UNKNOWN"}`;
    const confidence = card.querySelector(".confidence-badge");
    confidence.textContent = node.confidence ?? "CONFIRMED";
    confidence.classList.toggle("derived", node.confidence === "DERIVED");
    const shardingBadge = card.querySelector(".sharding-badge");
    if (node.attributes?.Sharding) {
      const unsharded = String(node.attributes.Sharding).startsWith("UNSHARDED");
      shardingBadge.textContent = unsharded ? "노샤딩" : "샤딩";
      shardingBadge.classList.remove("hidden");
      shardingBadge.classList.toggle("unsharded", unsharded);
      shardingBadge.classList.toggle("sharded", !unsharded);
    }
    const collapse = card.querySelector(".collapse-node");
    collapse.classList.toggle("hidden", !outgoing.has(node.id));
    collapse.textContent = state.collapsed.has(node.id) ? "+" : "−";
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
      else state.collapsed.add(node.id);
      renderGraph(false);
    });
    let clickTimer;
    card.addEventListener("click", () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => openDetails(node.id), 220);
    });
    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      clearTimeout(clickTimer);
      focusNode(node.id);
    });
    els.nodes.append(fragment);
  }
}

function renderEdges(edges, nodes) {
  els.edges.querySelectorAll(".edge, .edge-label").forEach((item) => item.remove());
  const namespace = "http://www.w3.org/2000/svg";
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const levelRank = { healthy: 0, unknown: 1, degraded: 2, critical: 3 };
  for (const edge of edges) {
    const source = state.positions.get(edge.source);
    const target = state.positions.get(edge.target);
    if (!source || !target) continue;
    const x1 = source.x + NODE_WIDTH / 2;
    const y1 = source.y + NODE_HEIGHT;
    const x2 = target.x + NODE_WIDTH / 2;
    const y2 = target.y;
    const bend = Math.max(54, Math.abs(y2 - y1) * 0.45);
    const level = [
      healthLevel(edge.status ?? "HEALTHY"),
      healthLevel(nodeById.get(edge.source)?.status),
      healthLevel(nodeById.get(edge.target)?.status),
    ].sort((a, b) => levelRank[b] - levelRank[a])[0];
    const path = document.createElementNS(namespace, "path");
    path.setAttribute(
      "class",
      `edge ${edge.confidence === "DERIVED" ? "derived" : ""} ${level}`,
    );
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
    );
    els.edges.append(path);
    if (edge.label) {
      const label = document.createElementNS(namespace, "text");
      label.setAttribute("class", `edge-label ${level}`);
      label.setAttribute("x", String((x1 + x2) / 2));
      label.setAttribute("y", String((y1 + y2) / 2 - 7));
      label.setAttribute("text-anchor", "middle");
      label.textContent = edge.label;
      els.edges.append(label);
    }
  }
}

function renderLegend(nodes) {
  const types = [...new Set(nodes.map((node) => node.type))];
  els.typeLegend.innerHTML = types
    .map((type) => {
      const category =
        type === "keyspace"
          ? "keyspace"
          : type === "shard"
            ? "shard"
            : type === "tablet"
              ? "tablet"
              : type === "gateway" || type === "servingGraph"
                ? "gateway"
                : type === "workflow"
                  ? "workflow"
                  : "control";
      return `<span><i class="legend-dot ${category}"></i>${escapeHtml(labelByType[type] ?? type)}</span>`;
    })
    .join("");
}

function applyTransform() {
  const { x, y, scale } = state.transform;
  els.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

function fitView() {
  const positions = [...state.positions.values()];
  if (!positions.length) return;
  const minX = Math.min(...positions.map((item) => item.x));
  const minY = Math.min(...positions.map((item) => item.y));
  const maxX = Math.max(...positions.map((item) => item.x + NODE_WIDTH));
  const maxY = Math.max(...positions.map((item) => item.y + NODE_HEIGHT));
  const rect = els.viewport.getBoundingClientRect();
  const padding = 70;
  const scale = Math.min(
    1,
    Math.max(
      0.28,
      Math.min(
        (rect.width - padding * 2) / Math.max(1, maxX - minX),
        (rect.height - padding * 2) / Math.max(1, maxY - minY),
      ),
    ),
  );
  state.transform = {
    scale,
    x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale,
    y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale,
  };
  applyTransform();
}

function renderGraph(shouldFit = false) {
  const { nodes, edges } = visibleGraph();
  layout(nodes, edges);
  renderEdges(edges, nodes);
  renderNodes(nodes, edges);
  renderLegend(nodes);
  els.empty.classList.toggle("hidden", nodes.length > 0);
  if (shouldFit) requestAnimationFrame(fitView);
}

function updateFocusChip() {
  const node = state.topology?.nodes.find((item) => item.id === state.focusId);
  els.focusChip.classList.toggle("hidden", !node);
  if (!node) {
    els.focusLabel.textContent = "";
    els.focusLabel.removeAttribute("title");
    return;
  }
  const labels = state.focusTrail
    .map((id) => state.topology?.nodes.find((item) => item.id === id)?.label)
    .filter(Boolean);
  const compactLabels =
    labels.length > 4 ? ["…", ...labels.slice(-3)] : labels;
  els.focusLabel.textContent = `현재 기준: ${compactLabels.join(" › ")}`;
  els.focusLabel.title = labels.join(" › ");
}

function navigationUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  url.searchParams.delete("select");
  if (state.focusId) url.searchParams.set("focus", state.focusId);
  else url.searchParams.delete("focus");
  return `${url.pathname}${url.search}${url.hash}`;
}

function recordNavigation(mode = "push") {
  const payload = {
    vitessTopologyViewer: true,
    view: state.view,
    focusTrail: [...state.focusTrail],
  };
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method](payload, "", navigationUrl());
}

function closeDetailsForNavigation() {
  state.selectedId = null;
  state.collapsed.clear();
  els.detail.classList.remove("open");
  els.detail.setAttribute("aria-hidden", "true");
}

function focusNode(id) {
  id = normalizeFocusId(id);
  if (!state.topology?.nodes.some((node) => node.id === id)) return;
  if (state.focusId === id) {
    fitView();
    return;
  }
  state.focusTrail.push(id);
  state.focusId = id;
  closeDetailsForNavigation();
  updateFocusChip();
  recordNavigation("push");
  renderGraph(true);
}

function clearFocus({ record = true } = {}) {
  state.focusId = null;
  state.focusTrail = [];
  closeDetailsForNavigation();
  updateFocusChip();
  if (record) recordNavigation("push");
  renderGraph(true);
}

function navigateFocusBack() {
  if (!state.focusId || state.historyTransition) return false;
  state.historyTransition = true;
  window.history.back();
  window.setTimeout(() => {
    state.historyTransition = false;
  }, 350);
  return true;
}

function syncViewChrome() {
  document.querySelectorAll(".view-tab").forEach((item) =>
    item.classList.toggle("active", item.dataset.view === state.view),
  );
  const copy = viewCopy[state.view];
  els.viewKicker.textContent = copy.kicker;
  els.viewTitle.textContent = copy.title;
  els.viewDescription.textContent = copy.description;
}

function updateOverview() {
  const data = state.topology;
  if (!data) return;
  const healthy = data.overallStatus === "HEALTHY";
  const offline = data.overallStatus === "OFFLINE";
  const degradedClusters = data.cache?.degradedClusters ?? [];
  els.liveDot.className = `live-dot ${
    healthy ? "healthy" : offline || degradedClusters.length ? "error" : ""
  }`;
  els.clusterStatus.textContent =
    {
      HEALTHY: "LIVE · 모든 주요 조회 정상",
      PARTIAL: degradedClusters.length
        ? `장애 · ${degradedClusters.map((cluster) => cluster.id).join(", ")} 연결 실패`
        : "LIVE · 일부 조회 실패",
      STALE: "STALE · 마지막 정상 데이터",
      OFFLINE: "OFFLINE · vtctld 연결 실패",
    }[data.overallStatus] ?? data.overallStatus;
  els.lastCollected.textContent = `${formatTime(data.collectedAt)} · ${data.durationMs}ms`;
  document.querySelector("#metric-keyspaces").textContent = data.summary.keyspaces;
  document.querySelector("#metric-shards").textContent = data.nodes.filter(
    (node) => node.type === "shard" && !isUnsharded(node),
  ).length;
  document.querySelector("#metric-tablets").textContent = data.summary.tablets;

  const okSources = data.sourceSummaries.filter((source) => source.status === "ok").length;
  els.sourceSummary.textContent = `${okSources}/${data.sourceSummaries.length} 정상`;
  els.sourceList.innerHTML = data.sourceSummaries
    .map(
      (source) => `
        <div class="source-item ${escapeHtml(source.status)}">
          <i></i>
          <span>
            <strong title="${escapeHtml(source.label)}">${escapeHtml(source.label)}</strong>
            <small>${escapeHtml(source.status.toUpperCase())} · ${source.durationMs ?? 0}ms</small>
          </span>
        </div>`,
    )
    .join("");

  const workflowErrors = data.nodes.filter(
    (node) =>
      node.type === "workflow" &&
      ["ERROR", "DEGRADED"].includes(node.status),
  );
  const validationErrors = data.validation?.issues?.length ?? 0;
  const knownErrorCount =
    workflowErrors.length + data.errors.length + validationErrors;
  document.querySelector("#metric-errors").textContent = knownErrorCount;
  els.headerErrorCount.textContent = knownErrorCount;
  els.errorPageLink.classList.toggle("has-errors", knownErrorCount > 0);

  const showNotice = (message, { error = false, link = false } = {}) => {
    els.notice.className = `notice${error ? " error" : ""}`;
    els.noticeMessage.textContent = message;
    els.noticeAction.classList.toggle("hidden", !link);
  };

  if (degradedClusters.length) {
    showNotice(
      `${degradedClusters.map((cluster) => cluster.id).join(", ")} 연결이 실패했습니다. 해당 노드와 관계선을 삭제하지 않고 마지막 정상 상태를 빨간색으로 유지합니다.`,
      { error: true, link: true },
    );
  } else if (data.cache.stale) {
    showNotice(
      `vtctld 조회가 실패해 ${formatTime(data.cache.lastSuccessfulAt)}의 마지막 정상 토폴로지를 빨간 장애 상태로 유지합니다.`,
      { error: true, link: true },
    );
  } else if (offline) {
    showNotice(
      data.errors.find((error) => error.sourceId === "vtctld:keyspaces")?.error ??
        "vtctld에 연결할 수 없습니다. 설정에서 발견된 구조를 그래프에 임의로 추가하지 않았습니다.",
      { error: true, link: true },
    );
  } else if (workflowErrors.length) {
    showNotice(
      `서비스는 유지 중이지만 VReplication Workflow ${workflowErrors.length}개가 저하 상태입니다.`,
      { link: true },
    );
  } else if (data.errors.length) {
    showNotice(
      `${data.errors.length}개 보조 데이터 소스 조회가 실패했습니다. 정상 조회된 노드와 관계는 계속 표시됩니다.`,
      { link: true },
    );
  } else if (validationErrors) {
    showNotice(`그래프 검증 문제 ${validationErrors}개가 발견됐습니다.`, {
      error: true,
      link: true,
    });
  } else {
    els.notice.className = "notice hidden";
    els.noticeMessage.textContent = "";
    els.noticeAction.classList.add("hidden");
  }
}

function sourceById(id) {
  return state.topology?.sourceSummaries.find((source) => source.id === id);
}

function openDetails(id) {
  state.selectedId = id;
  const node = state.topology?.nodes.find((item) => item.id === id);
  if (!node) return;
  const errorMessage =
    node.status === "ERROR" ? node.attributes?.Message : undefined;
  const attributes = Object.entries(node.attributes ?? {})
    .filter(
      ([key, value]) =>
        value !== "" &&
        value !== undefined &&
        !(key === "Message" && errorMessage),
    )
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join("");
  const sourceButtons = (node.sourceIds ?? [])
    .map((sourceId) => {
      const source = sourceById(sourceId);
      if (!source) return "";
      return `
        <button class="source-button" type="button" data-source-id="${escapeHtml(sourceId)}">
          <span>${escapeHtml(source.label)}</span>
          <small>${escapeHtml(source.status.toUpperCase())} ↗</small>
        </button>`;
    })
    .join("");
  els.detailContent.innerHTML = `
    <span class="detail-type">${escapeHtml(iconByType[node.type] ?? "•")} · ${escapeHtml(labelByType[node.type] ?? node.type)}</span>
    <h2>${escapeHtml(node.label)}</h2>
    <p class="detail-subtitle">${escapeHtml(metaForNode(node))}</p>
    <div class="detail-badges">
      <span class="state-badge detail-${escapeHtml(String(node.status ?? "UNKNOWN").toLowerCase())}">${escapeHtml(node.status ?? "UNKNOWN")}</span>
      <span class="confidence-badge ${node.confidence === "DERIVED" ? "derived" : ""}">${escapeHtml(node.confidence ?? "CONFIRMED")}</span>
    </div>
    ${
      errorMessage
        ? `<section class="error-callout">
            <h3>ERROR MESSAGE</h3>
            <p>${escapeHtml(errorMessage)}</p>
          </section>`
        : ""
    }
    <section class="detail-section">
      <h3>CONFIRMED ATTRIBUTES</h3>
      <dl class="attribute-list">${attributes || "<div><dd>표시할 속성이 없습니다.</dd></div>"}</dl>
    </section>
    <section class="detail-section">
      <h3>DATA PROVENANCE</h3>
      <div class="source-buttons">${sourceButtons || "연결된 원본 소스 없음"}</div>
    </section>
    <section class="detail-section">
      <h3>COLLECTION</h3>
      <dl class="attribute-list">
        <div><dt>Collected</dt><dd>${escapeHtml(formatTime(state.topology.collectedAt))}</dd></div>
        <div><dt>Read only</dt><dd>YES</dd></div>
      </dl>
    </section>`;
  els.detailContent.querySelectorAll("[data-source-id]").forEach((button) => {
    button.addEventListener("click", () => openRaw(button.dataset.sourceId));
  });
  els.detail.classList.add("open");
  els.detail.setAttribute("aria-hidden", "false");
  renderGraph(false);
}

async function openRaw(id) {
  const source = sourceById(id);
  els.rawTitle.textContent = source?.label ?? id;
  els.rawContent.textContent = "원본 데이터를 불러오는 중…";
  els.rawDialog.showModal();
  try {
    const response = await fetch(`/api/raw/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    els.rawContent.textContent =
      typeof data.raw === "string"
        ? data.raw
        : JSON.stringify(data.raw, null, 2);
  } catch (error) {
    els.rawContent.textContent = `원본 데이터를 불러오지 못했습니다.\n${error.message}`;
  }
}

async function loadTopology(manual = false) {
  els.refresh.disabled = true;
  els.refresh.classList.add("loading");
  try {
    const response = await fetch(manual ? "/api/refresh" : "/api/topology", {
      method: manual ? "POST" : "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.topology = await response.json();
    updateFilters();
    updateOverview();
    renderGraph(!state.positions.size);
    if (state.selectedId) openDetails(state.selectedId);
  } catch (error) {
    els.notice.className = "notice error";
    els.noticeMessage.textContent = `뷰어 API 조회 실패: ${error.message}`;
    els.noticeAction.classList.add("hidden");
    els.liveDot.className = "live-dot error";
    els.clusterStatus.textContent = "VIEWER ERROR";
  } finally {
    els.refresh.disabled = false;
    els.refresh.classList.remove("loading");
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const interval = Number(els.refreshRate.value);
  if (interval > 0) {
    state.refreshTimer = setInterval(() => loadTopology(true), interval);
  }
}

document.querySelectorAll(".view-tab").forEach((button) => {
  button.classList.toggle("active", button.dataset.view === state.view);
  button.addEventListener("click", () => {
    if (state.view === button.dataset.view && !state.focusId) return;
    state.view = button.dataset.view;
    state.focusId = null;
    state.focusTrail = [];
    updateFocusChip();
    state.collapsed.clear();
    syncViewChrome();
    recordNavigation("push");
    renderGraph(true);
  });
});

syncViewChrome();

for (const input of [els.search, els.cell, els.keyspace, els.shard, els.tabletType]) {
  input.addEventListener("input", () => renderGraph(true));
  input.addEventListener("change", () => renderGraph(true));
}

els.resetFilters.addEventListener("click", () => {
  els.search.value = "";
  els.cell.value = "";
  els.keyspace.value = "";
  els.shard.value = "";
  els.tabletType.value = "";
  if (state.focusId) clearFocus();
  else renderGraph(true);
});

els.focusBack.addEventListener("click", navigateFocusBack);
els.focusReset.addEventListener("click", () => clearFocus());

els.refresh.addEventListener("click", () => loadTopology(true));
els.refreshRate.addEventListener("change", scheduleRefresh);
els.sourceToggle.addEventListener("click", () =>
  els.sourceList.classList.toggle("hidden"),
);
els.closeDetail.addEventListener("click", () => {
  state.selectedId = null;
  els.detail.classList.remove("open");
  els.detail.setAttribute("aria-hidden", "true");
  renderGraph(false);
});
els.closeRaw.addEventListener("click", () => els.rawDialog.close());

document.querySelector("#zoom-in").addEventListener("click", () => {
  state.transform.scale = Math.min(2, state.transform.scale * 1.15);
  applyTransform();
});
document.querySelector("#zoom-out").addEventListener("click", () => {
  if (state.focusId) {
    navigateFocusBack();
    return;
  }
  state.transform.scale = Math.max(0.25, state.transform.scale / 1.15);
  applyTransform();
});
document.querySelector("#zoom-reset").addEventListener("click", () => {
  state.transform = { x: 50, y: 40, scale: 1 };
  applyTransform();
});
document.querySelector("#fit-view").addEventListener("click", fitView);

els.viewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (event.deltaY > 0 && state.focusId) {
      navigateFocusBack();
      return;
    }
    const rect = els.viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const oldScale = state.transform.scale;
    const nextScale = Math.max(
      0.25,
      Math.min(2, oldScale * (event.deltaY < 0 ? 1.1 : 0.9)),
    );
    const worldX = (pointerX - state.transform.x) / oldScale;
    const worldY = (pointerY - state.transform.y) / oldScale;
    state.transform.scale = nextScale;
    state.transform.x = pointerX - worldX * nextScale;
    state.transform.y = pointerY - worldY * nextScale;
    applyTransform();
  },
  { passive: false },
);

els.viewport.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".graph-node")) return;
  state.dragging = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.transform.x,
    originY: state.transform.y,
  };
  els.viewport.setPointerCapture(event.pointerId);
  els.viewport.classList.add("dragging");
});

els.viewport.addEventListener("pointermove", (event) => {
  if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
  state.transform.x =
    state.dragging.originX + event.clientX - state.dragging.startX;
  state.transform.y =
    state.dragging.originY + event.clientY - state.dragging.startY;
  applyTransform();
});

els.viewport.addEventListener("pointerup", (event) => {
  if (state.dragging?.pointerId === event.pointerId) {
    state.dragging = null;
    els.viewport.classList.remove("dragging");
  }
});

window.addEventListener("resize", () => fitView());
window.addEventListener("popstate", (event) => {
  const navigation = event.state;
  if (!navigation?.vitessTopologyViewer) return;
  if (viewCopy[navigation.view]) state.view = navigation.view;
  state.focusTrail = Array.isArray(navigation.focusTrail)
    ? navigation.focusTrail
        .map(normalizeFocusId)
        .filter((id) => state.topology?.nodes.some((node) => node.id === id))
    : [];
  state.focusId = state.focusTrail.at(-1) ?? null;
  state.historyTransition = false;
  closeDetailsForNavigation();
  syncViewChrome();
  updateFocusChip();
  renderGraph(true);
});

scheduleRefresh();
applyTransform();
await loadTopology(false);
if (
  requestedFocus &&
  state.topology?.nodes.some((node) => node.id === requestedFocus)
) {
  state.focusId = normalizeFocusId(requestedFocus);
  state.focusTrail = [state.focusId];
  updateFocusChip();
  renderGraph(true);
}
recordNavigation("replace");
if (
  requestedSelection &&
  state.topology?.nodes.some((node) => node.id === requestedSelection)
) {
  openDetails(requestedSelection);
}
