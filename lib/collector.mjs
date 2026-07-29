import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PROCESS_TYPES = new Map([
  ["etcd", "topologyService"],
  ["vtctld", "controlPlane"],
  ["vtgate", "gateway"],
  ["vttablet", "tabletProcess"],
  ["vtorc", "orchestrator"],
  ["vtadmin", "admin"],
  ["vtadmin-api", "admin"],
  ["mysqlctl", "mysql"],
  ["mysqlctld", "mysql"],
]);

const TYPE_LABELS = {
  cluster: "Vitess Cluster",
  host: "Host",
  topologyService: "Topology Service",
  controlPlane: "vtctld",
  gateway: "VTGate",
  tabletProcess: "vttablet",
  orchestrator: "VTOrc",
  admin: "VTAdmin",
  cell: "Cell",
  keyspace: "Keyspace",
  vschema: "VSchema",
  shard: "Shard",
  tablet: "Tablet",
  mysql: "MySQL",
  servingGraph: "Serving Graph",
  workflow: "VReplication Workflow",
};

const COMPONENT_CATALOG = [
  { name: "vtctld", type: "controlPlane", graphWhenStopped: true },
  { name: "vtgate", type: "gateway", graphWhenStopped: true },
  { name: "vttablet", type: "tabletProcess", graphWhenStopped: true },
  { name: "vtorc", type: "orchestrator", graphWhenStopped: true },
  { name: "vtadmin", type: "admin", graphWhenStopped: true },
  { name: "mysqlctld", type: "mysql", graphWhenStopped: true },
  { name: "mysqlctl", type: "utility", graphWhenStopped: false },
  { name: "vtctldclient", type: "utility", graphWhenStopped: false },
];

const KEYSPACE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHARD_RE = /^[A-Za-z0-9_.:+-]{1,128}$/;
const CELL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SECRET_FLAG_RE =
  /(password|passwd|token|secret|credential|private[-_]?key|grpc-auth-static-client-creds|mysql-auth-server-static-file)/i;

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeEnum(value) {
  const numeric = Number(value);
  const tabletTypes = [
    "UNKNOWN",
    "PRIMARY",
    "REPLICA",
    "RDONLY",
    "SPARE",
    "EXPERIMENTAL",
    "BACKUP",
    "RESTORE",
    "DRAINED",
  ];
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < tabletTypes.length) {
    return tabletTypes[numeric];
  }
  return String(value ?? "UNKNOWN").replace(/^TABLET_TYPE_/, "").toUpperCase();
}

function safeId(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 240);
}

export function aliasString(value) {
  if (typeof value === "string") return value;
  const alias = object(value);
  const cell = first(alias.cell, alias.Cell);
  const uid = Number(first(alias.uid, alias.Uid, alias.UID));
  if (!cell || !Number.isFinite(uid)) return "";
  return `${cell}-${String(uid).padStart(10, "0")}`;
}

function redactText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(
      /((?:password|passwd|token|secret|credential|private[-_]?key)\s*[=:]\s*)([^\s"',]+)/gi,
      "$1<redacted>",
    )
    .replace(/(Authorization:\s*)([^\r\n]+)/gi, "$1<redacted>");
}

function redactArgs(args) {
  const result = [];
  let redactNext = false;
  for (const raw of args) {
    const arg = String(raw);
    if (redactNext) {
      result.push("<redacted>");
      redactNext = false;
      continue;
    }
    const equal = arg.indexOf("=");
    const key = equal >= 0 ? arg.slice(0, equal) : arg;
    if (SECRET_FLAG_RE.test(key)) {
      if (equal >= 0) result.push(`${key}=<redacted>`);
      else {
        result.push(key);
        redactNext = true;
      }
      continue;
    }
    result.push(redactText(arg));
  }
  return result;
}

function safeRaw(value) {
  if (typeof value === "string") return redactText(value).slice(0, 500_000);
  try {
    return JSON.parse(
      JSON.stringify(value, (key, item) =>
        SECRET_FLAG_RE.test(key) ? "<redacted>" : item,
      ),
    );
  } catch {
    return String(value).slice(0, 500_000);
  }
}

function flagValue(args, ...names) {
  const wanted = new Set(
    names.flatMap((name) => {
      const bare = name.replace(/^--/, "");
      return [bare, bare.replaceAll("-", "_"), bare.replaceAll("_", "-")];
    }),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const normalized = rawName.replaceAll("_", "-");
    if (![...wanted].some((name) => name.replaceAll("_", "-") === normalized)) {
      continue;
    }
    if (inline !== undefined) return inline;
    return args[index + 1] && !args[index + 1].startsWith("--")
      ? args[index + 1]
      : "true";
  }
  return undefined;
}

function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const startCandidates = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter(
      (index) => index >= 0,
    );
    if (!startCandidates.length) return null;
    const start = Math.min(...startCandidates);
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function sourceRecord({
  id,
  label,
  kind,
  status,
  startedAt,
  durationMs,
  command,
  endpoint,
  error,
  raw,
}) {
  return {
    id,
    label,
    kind,
    status,
    collectedAt: startedAt,
    durationMs,
    command,
    endpoint,
    error: error ? redactText(String(error)).slice(0, 3000) : undefined,
    raw: safeRaw(raw),
  };
}

async function fixedExec(file, args, timeoutMs) {
  const result = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function collectExecSource({
  id,
  label,
  kind = "command",
  file,
  args,
  timeoutMs,
}) {
  const startedAt = nowIso();
  const started = performance.now();
  try {
    const result = await fixedExec(file, args, timeoutMs);
    const raw = result.stdout.trim() || result.stderr.trim();
    return sourceRecord({
      id,
      label,
      kind,
      status: "ok",
      startedAt,
      durationMs: Math.round(performance.now() - started),
      command: [file, ...redactArgs(args)],
      raw,
    });
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    return sourceRecord({
      id,
      label,
      kind,
      status: "error",
      startedAt,
      durationMs: Math.round(performance.now() - started),
      command: [file, ...redactArgs(args)],
      error: first(stderr.trim(), error.message, "command failed"),
      raw: first(stdout.trim(), stderr.trim(), ""),
    });
  }
}

async function collectHttpSource({ id, label, endpoint, timeoutMs }) {
  const startedAt = nowIso();
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json, text/plain, text/html;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseJson(text);
    if (parsed?.ok === false) {
      return sourceRecord({
        id,
        label,
        kind: "http",
        status: "error",
        startedAt,
        durationMs: Math.round(performance.now() - started),
        endpoint,
        error: first(
          parsed?.error?.message,
          parsed?.error,
          parsed?.message,
          "API returned ok=false",
        ),
        raw: parsed,
      });
    }
    return sourceRecord({
      id,
      label,
      kind: "http",
      status: "ok",
      startedAt,
      durationMs: Math.round(performance.now() - started),
      endpoint,
      raw: parsed ?? text,
    });
  } catch (error) {
    return sourceRecord({
      id,
      label,
      kind: "http",
      status: "error",
      startedAt,
      durationMs: Math.round(performance.now() - started),
      endpoint,
      error: error.message,
      raw: "",
    });
  }
}

function apiEndpoint(base, route, parameters = {}) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function collectVtadminSources(config) {
  if (!config.vtadminApiUrl) return [];
  const endpoints = [
    ["clusters", "VTAdmin clusters"],
    ["keyspaces", "VTAdmin keyspaces and shards"],
    ["tablets", "VTAdmin tablets"],
    ["vschemas", "VTAdmin VSchema"],
    ["srvkeyspaces", "VTAdmin serving graph"],
    ["vtctlds", "VTAdmin vtctld endpoints"],
  ];
  const sources = await Promise.all(
    endpoints.map(([route, label]) =>
      collectHttpSource({
        id: `vtadmin:${route}`,
        label,
        endpoint: apiEndpoint(config.vtadminApiUrl, `api/${route}`),
        timeoutMs: config.httpTimeoutMs,
      }),
    ),
  );
  const clustersSource = sources.find(
    (source) => source.id === "vtadmin:clusters",
  );
  const clusterIds = asArray(vtadminResult(clustersSource, "clusters"))
    .map((cluster) => String(cluster?.id ?? ""))
    .filter(
      (id) =>
        id &&
        id !== config.vtadminLocalClusterId &&
        KEYSPACE_RE.test(id),
    );
  const healthSources = await Promise.all(
    clusterIds.map((clusterId) =>
      collectHttpSource({
        id: `vtadmin:cluster:${safeId(clusterId)}:keyspaces`,
        label: `VTAdmin cluster health · ${clusterId}`,
        endpoint: apiEndpoint(config.vtadminApiUrl, "api/keyspaces", {
          cluster: clusterId,
        }),
        timeoutMs: config.httpTimeoutMs,
      }),
    ),
  );
  return [...sources, ...healthSources];
}

function commandRawJson(source) {
  return parseJson(typeof source.raw === "string" ? source.raw : JSON.stringify(source.raw));
}

function processDisplayName(processInfo) {
  const suffix =
    flagValue(processInfo.args, "tablet-path") ||
    flagValue(processInfo.args, "cell") ||
    "";
  return suffix ? `${processInfo.name} · ${suffix}` : processInfo.name;
}

async function discoverProcesses() {
  const processes = [];
  let procEntries = [];
  try {
    procEntries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return processes;
  }

  await Promise.all(
    procEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const cmdlineBuffer = await readFile(`/proc/${pid}/cmdline`);
          const args = cmdlineBuffer
            .toString("utf8")
            .split("\0")
            .filter(Boolean);
          if (!args.length) return;
          const exe = await readlink(`/proc/${pid}/exe`).catch(() => args[0]);
          const name = path.basename(exe).replace(/\s+\(deleted\)$/, "");
          const knownType = PROCESS_TYPES.get(name);
          const isTabletMysql =
            name === "mysqld" &&
            args.some((arg) => /\/vt\/vtdataroot\/vt_\d+/i.test(arg));
          if (!knownType && !isTabletMysql) return;
          const statusText = await readFile(`/proc/${pid}/status`, "utf8").catch(
            () => "",
          );
          const uid = Number(statusText.match(/^Uid:\s+(\d+)/m)?.[1] ?? -1);
          const startedTicks = Number(
            (await readFile(`/proc/${pid}/stat`, "utf8"))
              .toString()
              .match(/^\d+\s+\(.+\)\s+\S+\s+(?:\S+\s+){18}(\d+)/)?.[1] ?? 0,
          );
          processes.push({
            pid,
            uid,
            name,
            executable: exe,
            args: redactArgs(args.slice(1)),
            rawArgs: args.slice(1),
            componentType: knownType ?? "mysql",
            startedTicks,
          });
        } catch {
          // A process may exit while /proc is being read.
        }
      }),
  );
  return processes.sort((a, b) => a.pid - b.pid);
}

function parseNetstat(text) {
  const byPid = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^tcp/.test(line.trim())) continue;
    const columns = line.trim().split(/\s+/);
    if (columns.length < 7 || columns[5] !== "LISTEN") continue;
    const local = columns[3];
    const owner = columns[6];
    const pid = Number(owner.split("/")[0]);
    const port = Number(local.match(/:(\d+)$/)?.[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(port)) continue;
    const address = local.slice(0, local.length - String(port).length - 1);
    const list = byPid.get(pid) ?? [];
    list.push({ address, port, protocol: columns[0] });
    byPid.set(pid, list);
  }
  return byPid;
}

function parseVtgateTablets(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const columns = line.trim().split(/\t+|\s{2,}/).map((value) => value.trim());
    if (columns.length < 6 || columns[0].toLowerCase() === "cell") continue;
    const [cell, keyspace, shard, tabletType, state, alias, hostname] = columns;
    if (
      !CELL_RE.test(cell) ||
      !KEYSPACE_RE.test(keyspace) ||
      !SHARD_RE.test(shard) ||
      !aliasString(alias)
    ) {
      continue;
    }
    rows.push({
      cell,
      keyspace,
      shard,
      tabletType: normalizeEnum(tabletType),
      state: String(state).toUpperCase(),
      alias,
      hostname,
    });
  }
  return rows;
}

async function readStartScript(startScript) {
  const startedAt = nowIso();
  const started = performance.now();
  if (!startScript) {
    return {
      source: sourceRecord({
        id: "config:start-script",
        label: "Optional Vitess start script",
        kind: "file",
        status: "skipped",
        startedAt,
        durationMs: 0,
        raw: "",
      }),
      config: { path: "" },
    };
  }
  try {
    const text = await readFile(startScript, "utf8");
    const exports = {};
    for (const match of text.matchAll(
      /^\s*export\s+([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s#]+))/gm,
    )) {
      const key = match[1];
      if (SECRET_FLAG_RE.test(key)) continue;
      exports[key] = first(match[2], match[3], match[4], "");
    }
    const config = {
      path: startScript,
      exports,
      vtctldAddress:
        text.match(/vtctldclient\s+--server\s+([^\s"'\\]+)/)?.[1] ??
        text.match(/--server\s+localhost:(\d+)/)?.[0]?.replace("--server ", "") ??
        undefined,
      topologyImplementation:
        exports.TOPO ??
        text.match(/--topo-implementation(?:=|\s+)([^\s"'\\]+)/)?.[1],
      configuredKeyspaces: [
        ...text.matchAll(/^\s*ensure_keyspace\s+([A-Za-z0-9_.:-]+)\s+/gm),
      ].map((match) => match[1]),
      configuredTablets: [
        ...text.matchAll(
          /^\s*start_vttablet_for\s+([A-Za-z0-9_.:-]+)\s+"?([A-Za-z0-9_.:+-]+)"?\s+(\d+)/gm,
        ),
      ].map((match) => ({
        keyspace: match[1],
        shard: match[2],
        uid: Number(match[3]),
      })),
      configuredPorts: [
        ...new Set(
          [
            ...text.matchAll(
              /--(?:grpc[-_]port|mysql[-_]server[-_]port|port)(?:=|\s+)"?(\d+)"?/g,
            ),
          ].map((match) => Number(match[1])),
        ),
      ].sort((a, b) => a - b),
    };
    return {
      source: sourceRecord({
        id: "config:start-script",
        label: "Configured start script",
        kind: "file",
        status: "ok",
        startedAt,
        durationMs: Math.round(performance.now() - started),
        raw: text,
      }),
      config,
    };
  } catch (error) {
    return {
      source: sourceRecord({
        id: "config:start-script",
        label: "Configured start script",
        kind: "file",
        status: "error",
        startedAt,
        durationMs: Math.round(performance.now() - started),
        error: error.message,
        raw: "",
      }),
      config: { path: startScript },
    };
  }
}

async function discoverInstalledComponents(vtctldclientPath) {
  const binDir = path.dirname(vtctldclientPath);
  const candidates = [
    ...COMPONENT_CATALOG.map((component) => ({
      ...component,
      executable: path.join(binDir, component.name),
    })),
    {
      name: "etcd",
      type: "topologyService",
      graphWhenStopped: true,
      executable: process.env.VTV_ETCD_PATH ?? "/opt/vitess/etcd/etcd",
    },
  ];
  return Promise.all(
    candidates.map(async (component) => {
      try {
        const fileStat = await stat(component.executable);
        return {
          ...component,
          installed: fileStat.isFile(),
          size: fileStat.size,
        };
      } catch {
        return { ...component, installed: false };
      }
    }),
  );
}

function extractNamesFromResponse(value, key) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : first(item?.name, item?.keyspace)))
      .filter(Boolean);
  }
  const root = object(value);
  const candidate = first(root[key], root[key.replace(/s$/, "")], root.names);
  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => (typeof item === "string" ? item : first(item?.name, item?.keyspace)))
      .filter(Boolean);
  }
  if (candidate && typeof candidate === "object") return Object.keys(candidate);
  return [];
}

export function extractKeyspaceNames(value) {
  const names = extractNamesFromResponse(value, "keyspaces");
  if (names.length) return [...new Set(names.filter((name) => KEYSPACE_RE.test(name)))];
  const root = object(value);
  return Object.keys(root).filter(
    (name) =>
      KEYSPACE_RE.test(name) &&
      !["error", "status", "message", "metadata"].includes(name.toLowerCase()),
  );
}

function shardEntries(value) {
  const root = object(value);
  const candidate = first(root.shards, root.Shards, root.shardMap);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return Object.entries(candidate);
  }
  if (Array.isArray(candidate)) {
    return candidate.map((item) => [first(item?.name, item?.shard?.name), item]);
  }
  return [];
}

function keyRangeLabel(value, fallback) {
  const range = object(value);
  const decode = (input) => {
    if (!input) return "";
    try {
      return Buffer.from(String(input), "base64").toString("hex").toUpperCase();
    } catch {
      return String(input);
    }
  };
  const start = decode(first(range.start, range.Start, ""));
  const end = decode(first(range.end, range.End, ""));
  if (start || end) return `${start || ""}-${end || ""}`;
  return fallback;
}

export function extractShards(value) {
  return shardEntries(value)
    .map(([name, raw]) => {
      const wrapper = object(raw);
      const shard = object(first(wrapper.shard, wrapper.Shard, wrapper));
      const shardName = String(first(name, wrapper.name, shard.name, ""));
      if (!SHARD_RE.test(shardName)) return null;
      return {
        name: shardName,
        keyRange: keyRangeLabel(
          first(shard.keyRange, shard.key_range, wrapper.keyRange, wrapper.key_range),
          shardName,
        ),
        primaryAlias: aliasString(
          first(
            shard.primaryAlias,
            shard.primary_alias,
            wrapper.primaryAlias,
            wrapper.primary_alias,
          ),
        ),
        isPrimaryServing: first(
          shard.isPrimaryServing,
          shard.is_primary_serving,
          wrapper.isPrimaryServing,
        ),
        raw,
      };
    })
    .filter(Boolean);
}

function tabletValues(value) {
  if (Array.isArray(value)) return value;
  const root = object(value);
  const tablets = first(root.tablets, root.Tablets);
  if (Array.isArray(tablets)) return tablets;
  if (tablets && typeof tablets === "object") return Object.values(tablets);
  const values = Object.values(root);
  if (
    values.length &&
    values.every((item) => item && typeof item === "object")
  ) {
    return values;
  }
  return [];
}

export function extractTablets(value) {
  return tabletValues(value)
    .map((raw) => {
      const wrapper = object(raw);
      const tablet = object(first(wrapper.tablet, wrapper.Tablet, wrapper));
      const alias = aliasString(
        first(tablet.alias, tablet.tabletAlias, tablet.tablet_alias, wrapper.alias),
      );
      if (!alias) return null;
      const portMap = object(first(tablet.portMap, tablet.port_map));
      return {
        alias,
        cell: first(
          tablet.alias?.cell,
          tablet.tabletAlias?.cell,
          tablet.tablet_alias?.cell,
          alias.match(/^(.+)-\d{10}$/)?.[1],
        ),
        keyspace: String(first(tablet.keyspace, wrapper.keyspace, "")),
        shard: String(first(tablet.shard, wrapper.shard, "")),
        type: normalizeEnum(first(tablet.type, tablet.tabletType, tablet.tablet_type)),
        hostname: first(tablet.hostname, tablet.hostName),
        mysqlHostname: first(tablet.mysqlHostname, tablet.mysql_hostname),
        mysqlPort: Number(first(tablet.mysqlPort, tablet.mysql_port)) || undefined,
        ports: Object.fromEntries(
          Object.entries(portMap).map(([key, port]) => [key, Number(port)]),
        ),
        servingState: first(
          wrapper.servingState,
          wrapper.serving_state,
          tablet.servingState,
        ),
        primaryTermStartTime: first(
          tablet.primaryTermStartTime,
          tablet.primary_term_start_time,
        ),
        raw,
      };
    })
    .filter(Boolean);
}

function workflowValues(value) {
  const root = object(value);
  const candidate = first(root.workflows, root.Workflows);
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    return Object.entries(candidate).map(([name, workflow]) => ({ name, ...workflow }));
  }
  return [];
}

function srvEntries(value) {
  const root = object(value);
  const candidate = first(
    root.srvKeyspaces,
    root.srv_keyspaces,
    root.srvKeyspaceByCell,
    root,
  );
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  return Object.entries(candidate).filter(([cell]) => CELL_RE.test(cell));
}

function srvShardReferences(record) {
  const refs = [];
  const partitions = asArray(
    first(record?.partitions, record?.Partitions, record?.srvKeyspace?.partitions),
  );
  for (const partition of partitions) {
    const tabletType = normalizeEnum(
      first(partition?.servedType, partition?.served_type, partition?.tabletType),
    );
    for (const ref of asArray(
      first(partition?.shardReferences, partition?.shard_references),
    )) {
      const name = first(ref?.name, ref?.shard);
      if (name && SHARD_RE.test(name)) refs.push({ name, tabletType, raw: ref });
    }
  }
  return refs;
}

function addNode(graph, node) {
  if (!node?.id || graph.nodeIds.has(node.id)) return;
  graph.nodeIds.add(node.id);
  graph.nodes.push({
    status: "HEALTHY",
    confidence: "CONFIRMED",
    attributes: {},
    sourceIds: [],
    ...node,
  });
}

function addEdge(graph, edge) {
  if (!edge?.source || !edge?.target) return;
  if (!graph.nodeIds.has(edge.source) || !graph.nodeIds.has(edge.target)) return;
  const id = edge.id ?? `edge:${safeId(edge.type)}:${edge.source}:${edge.target}`;
  if (graph.edgeIds.has(id)) return;
  graph.edgeIds.add(id);
  graph.edges.push({
    id,
    confidence: "CONFIRMED",
    sourceIds: [],
    ...edge,
  });
}

function newGraph() {
  return { nodes: [], edges: [], nodeIds: new Set(), edgeIds: new Set() };
}

function typeLabel(type) {
  return TYPE_LABELS[type] ?? type;
}

function makeVtclientArgs(config, commandArgs) {
  return [
    "--server",
    config.vtctldAddress,
    "--action-timeout",
    `${Math.max(1, Math.ceil(config.commandTimeoutMs / 1000))}s`,
    "--compact",
    ...commandArgs,
  ];
}

async function vtclientSource(config, id, label, commandArgs) {
  return collectExecSource({
    id,
    label,
    file: config.vtctldclientPath,
    args: makeVtclientArgs(config, commandArgs),
    timeoutMs: config.commandTimeoutMs + 500,
  });
}

function processAttributes(info, listeners) {
  const attributes = {
    PID: info.pid,
    Executable: info.executable,
    "Listen ports": listeners.map((listener) => listener.port).join(", ") || "none found",
    Command: [info.name, ...info.args].join(" "),
  };
  const mappings = [
    ["Cell", ["cell"]],
    ["Keyspace", ["init-keyspace", "init_keyspace"]],
    ["Shard", ["init-shard", "init_shard"]],
    ["Tablet alias", ["tablet-path", "tablet_path"]],
    ["HTTP port", ["port"]],
    ["gRPC port", ["grpc-port", "grpc_port"]],
    ["MySQL port", ["mysql-server-port", "mysql_server_port", "mysql-port"]],
    ["Topology", ["topo-implementation", "topo_implementation"]],
    ["Topology address", ["topo-global-server-address", "topo_global_server_address"]],
  ];
  for (const [label, names] of mappings) {
    const value = flagValue(info.rawArgs, ...names);
    if (value !== undefined) attributes[label] = value;
  }
  return attributes;
}

function validateGraph(graph) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const issues = [];
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push(`dangling edge ${edge.id}`);
    }
  }
  for (const tablet of graph.nodes.filter((node) => node.type === "tablet")) {
    if (!tablet.attributes.Keyspace || !tablet.attributes.Shard) {
      issues.push(`tablet ${tablet.label} lacks keyspace/shard`);
    }
  }
  return issues;
}

function vtadminResult(source, key) {
  const raw =
    typeof source?.raw === "string" ? parseJson(source.raw) : object(source?.raw);
  return object(object(raw).result)[key];
}

function clusterDescriptor(record) {
  const cluster = object(record?.cluster);
  const id = String(first(cluster.id, record?.cluster_id, ""));
  if (!id || !KEYSPACE_RE.test(id)) return null;
  return {
    id,
    name: String(first(cluster.name, record?.cluster_name, id)),
  };
}

function endpointHost(value) {
  const address = String(value ?? "").replace(/^https?:\/\//, "");
  try {
    return new URL(`http://${address}`).hostname;
  } catch {
    return address.split(":")[0] || "";
  }
}

function externalId(type, clusterId, ...parts) {
  return `${type}:vtadmin:${safeId(clusterId)}${parts
    .map((part) => `:${safeId(part)}`)
    .join("")}`;
}

function tabletServingState(record) {
  const state = first(record?.state, record?.serving_state, record?.servingState);
  if (Number(state) === 1) return "SERVING";
  if (Number(state) === 0) return "UNKNOWN";
  return String(state ?? "UNKNOWN").toUpperCase();
}

export function buildExternalVtadminTopology(
  payload,
  { localClusterId = "local" } = {},
) {
  const graph = newGraph();
  const verified = {
    cells: [],
    keyspaces: [],
    shards: [],
    tablets: [],
    primaries: [],
    workflows: [],
  };
  const clusters = asArray(payload?.clusters);
  const keyspaces = asArray(payload?.keyspaces);
  const tablets = asArray(payload?.tablets);
  const vschemas = asArray(payload?.vschemas);
  const vtctlds = asArray(payload?.vtctlds);
  const srvKeyspaces = object(payload?.srvKeyspaces);
  const clusterById = new Map();

  const rememberCluster = (value) => {
    const descriptor = clusterDescriptor(value);
    if (descriptor && descriptor.id !== localClusterId) {
      clusterById.set(descriptor.id, {
        ...clusterById.get(descriptor.id),
        ...descriptor,
      });
    }
  };
  for (const cluster of clusters) {
    rememberCluster({ cluster });
  }
  for (const value of [...keyspaces, ...tablets, ...vschemas, ...vtctlds]) {
    rememberCluster(value);
  }

  for (const cluster of clusterById.values()) {
    const clusterId = externalId("cluster", cluster.id);
    const clusterKeyspaces = keyspaces.filter(
      (record) => clusterDescriptor(record)?.id === cluster.id,
    );
    const clusterTablets = tablets.filter(
      (record) => clusterDescriptor(record)?.id === cluster.id,
    );
    const clusterVschemas = vschemas.filter(
      (record) => clusterDescriptor(record)?.id === cluster.id,
    );
    const clusterVtctlds = vtctlds.filter(
      (record) => clusterDescriptor(record)?.id === cluster.id,
    );
    const hostnames = new Set(
      [
        ...clusterTablets.map((record) => record?.tablet?.hostname),
        ...clusterVtctlds.flatMap((record) => [
          endpointHost(record?.hostname),
          endpointHost(record?.FQDN),
        ]),
      ].filter(Boolean),
    );

    addNode(graph, {
      id: clusterId,
      type: "cluster",
      label: cluster.name,
      attributes: {
        "Cluster ID": cluster.id,
        "Cluster name": cluster.name,
        Source: "VTAdmin multi-cluster API",
        "Observed keyspaces": clusterKeyspaces.length,
        "Observed tablets": clusterTablets.length,
      },
      sourceIds: ["vtadmin:clusters", "vtadmin:keyspaces", "vtadmin:tablets"],
    });

    for (const hostname of hostnames) {
      const hostId = externalId("host", cluster.id, hostname);
      addNode(graph, {
        id: hostId,
        type: "host",
        label: hostname,
        attributes: {
          Hostname: hostname,
          "Cluster ID": cluster.id,
          Platform: "Remote server · not queried",
        },
        sourceIds: ["vtadmin:tablets", "vtadmin:vtctlds"],
      });
      addEdge(graph, {
        source: hostId,
        target: clusterId,
        type: "hosts",
        label: "hosts cluster endpoint",
        views: ["physical"],
        sourceIds: ["vtadmin:tablets", "vtadmin:vtctlds"],
      });
    }

    for (const [index, record] of clusterVtctlds.entries()) {
      const id = externalId(
        "control",
        cluster.id,
        first(record.hostname, record.FQDN, index),
      );
      addNode(graph, {
        id,
        type: "controlPlane",
        label: `vtctld · ${first(record.hostname, record.FQDN, cluster.id)}`,
        attributes: {
          "Cluster ID": cluster.id,
          "gRPC endpoint": first(record.hostname, "UNKNOWN"),
          "HTTP endpoint": first(record.FQDN, "UNKNOWN"),
          Source: "VTAdmin discovery",
        },
        sourceIds: ["vtadmin:vtctlds"],
      });
      addEdge(graph, {
        source: clusterId,
        target: id,
        type: "component",
        label: "vtctld",
        views: ["physical"],
        sourceIds: ["vtadmin:vtctlds"],
      });
    }

    const cells = [
      ...new Set(
        clusterTablets
          .map((record) => aliasString(record?.tablet?.alias))
          .map((alias) => alias.match(/^(.+)-\d{10}$/)?.[1])
          .filter(Boolean),
      ),
    ];
    for (const cell of cells) {
      verified.cells.push(cell);
      const cellId = externalId("cell", cluster.id, cell);
      addNode(graph, {
        id: cellId,
        type: "cell",
        label: cell,
        attributes: { Cell: cell, "Cluster ID": cluster.id },
        sourceIds: ["vtadmin:tablets"],
      });
      addEdge(graph, {
        source: clusterId,
        target: cellId,
        type: "contains",
        label: "cell",
        views: ["physical"],
        sourceIds: ["vtadmin:tablets"],
      });
    }

    const hasServingGraph = clusterKeyspaces.some((record) => {
      const keyspace = first(record?.keyspace?.name, record?.name);
      return Boolean(object(srvKeyspaces[keyspace]).srv_keyspaces);
    });
    const gatewayId = externalId("gateway", cluster.id);
    if (hasServingGraph) {
      addNode(graph, {
        id: gatewayId,
        type: "gateway",
        label: `VTGate · ${cluster.name}`,
        attributes: {
          "Cluster ID": cluster.id,
          Source: "VTAdmin serving-graph query",
          Observation: "VTGate responded to GetSrvKeyspaces",
        },
        sourceIds: ["vtadmin:srvkeyspaces"],
      });
      addEdge(graph, {
        source: clusterId,
        target: gatewayId,
        type: "component",
        label: "VTGate",
        views: ["physical"],
        sourceIds: ["vtadmin:srvkeyspaces"],
      });
    }

    for (const record of clusterKeyspaces) {
      const keyspace = String(first(record?.keyspace?.name, record?.name, ""));
      if (!KEYSPACE_RE.test(keyspace)) continue;
      verified.keyspaces.push(keyspace);
      const keyspaceId = externalId("keyspace", cluster.id, keyspace);
      const vschemaRecord = clusterVschemas.find(
        (entry) => first(entry?.name, entry?.keyspace) === keyspace,
      );
      const vschema = object(first(vschemaRecord?.v_schema, vschemaRecord?.vschema));
      const shards = extractShards({ shards: record?.shards });
      const sharded =
        typeof vschema.sharded === "boolean"
          ? vschema.sharded
          : shards.length > 1 || shards.some((shard) => shard.name !== "0");
      const shardingMode = sharded ? "SHARDED" : "UNSHARDED";
      addNode(graph, {
        id: keyspaceId,
        type: "keyspace",
        label: keyspace,
        attributes: {
          "Cluster ID": cluster.id,
          "Cluster name": cluster.name,
          Keyspace: keyspace,
          Durability: first(
            record?.keyspace?.keyspace?.durability_policy,
            record?.keyspace?.keyspace?.durabilityPolicy,
            "UNKNOWN",
          ),
          Sharding:
            shardingMode === "SHARDED"
              ? "SHARDED (샤딩)"
              : "UNSHARDED (노샤딩)",
          "Partition count": shards.length,
          "Partition layout":
            shardingMode === "UNSHARDED"
              ? "1 unsharded partition (topology shard 0)"
              : shards.map((shard) => shard.name).join(", "),
          "VSchema tables": Object.keys(object(vschema.tables)).length,
          "VSchema vindexes": Object.keys(object(vschema.vindexes)).length,
        },
        sourceIds: ["vtadmin:keyspaces", "vtadmin:vschemas"],
      });
      addEdge(graph, {
        source: clusterId,
        target: keyspaceId,
        type: "contains",
        label: "keyspace",
        views: ["logical"],
        sourceIds: ["vtadmin:keyspaces"],
      });

      const primaryAliasByShard = new Map();
      for (const shard of shards) {
        const shardId = externalId("shard", cluster.id, keyspace, shard.name);
        const isUnsharded = shardingMode === "UNSHARDED" && shard.name === "0";
        verified.shards.push({
          clusterId: cluster.id,
          keyspace,
          shard: shard.name,
          keyRange: shard.keyRange,
          sharding: shardingMode,
        });
        if (shard.primaryAlias) {
          primaryAliasByShard.set(shard.name, shard.primaryAlias);
          verified.primaries.push({
            clusterId: cluster.id,
            keyspace,
            shard: shard.name,
            alias: shard.primaryAlias,
          });
        }
        addNode(graph, {
          id: shardId,
          type: "shard",
          label: isUnsharded ? "노샤딩 · 단일 파티션" : shard.name,
          status:
            shard.primaryAlias && shard.isPrimaryServing !== false
              ? "HEALTHY"
              : "CRITICAL",
          attributes: {
            "Cluster ID": cluster.id,
            Keyspace: keyspace,
            Shard: shard.name,
            "Key range": isUnsharded ? "N/A (unsharded)" : shard.keyRange,
            Sharding: isUnsharded
              ? "UNSHARDED (노샤딩)"
              : "SHARDED (샤딩)",
            "Primary alias": shard.primaryAlias || "UNKNOWN",
            Serving:
              shard.isPrimaryServing === undefined
                ? "UNKNOWN"
                : String(shard.isPrimaryServing),
          },
          sourceIds: ["vtadmin:keyspaces", "vtadmin:vschemas"],
        });
        addEdge(graph, {
          source: keyspaceId,
          target: shardId,
          type: "contains",
          label: isUnsharded ? "unsharded partition" : "shard",
          views: ["logical", "replication"],
          sourceIds: ["vtadmin:keyspaces"],
        });
      }

      const keyspaceTablets = clusterTablets.filter(
        (entry) => entry?.tablet?.keyspace === keyspace,
      );
      for (const wrapper of keyspaceTablets) {
        const tablet = extractTablets([wrapper])[0];
        if (!tablet || !SHARD_RE.test(tablet.shard)) continue;
        const tabletId = externalId("tablet", cluster.id, tablet.alias);
        const shardId = externalId("shard", cluster.id, keyspace, tablet.shard);
        const isPrimary =
          primaryAliasByShard.get(tablet.shard) === tablet.alias;
        const servingState = tabletServingState(wrapper);
        verified.tablets.push({
          clusterId: cluster.id,
          alias: tablet.alias,
          cell: tablet.cell,
          keyspace,
          shard: tablet.shard,
          type: tablet.type,
        });
        addNode(graph, {
          id: tabletId,
          type: "tablet",
          label: tablet.alias,
          status:
            servingState === "SERVING"
              ? "HEALTHY"
              : tablet.type === "PRIMARY"
                ? "CRITICAL"
                : servingState === "UNKNOWN"
                  ? "UNKNOWN"
                  : "DEGRADED",
          attributes: {
            "Cluster ID": cluster.id,
            Alias: tablet.alias,
            Cell: tablet.cell ?? "UNKNOWN",
            Keyspace: keyspace,
            Shard: tablet.shard,
            "Tablet type": tablet.type,
            Primary: isPrimary ? "yes" : "no",
            Hostname: tablet.hostname ?? "UNKNOWN",
            Serving: servingState,
            "VTAdmin FQDN": first(wrapper.FQDN, "UNKNOWN"),
          },
          sourceIds: ["vtadmin:tablets", "vtadmin:keyspaces"],
        });
        addEdge(graph, {
          source: shardId,
          target: tabletId,
          type: isPrimary ? "primary" : "tablet",
          label: isPrimary ? "PRIMARY" : tablet.type,
          views: isPrimary
            ? ["logical", "replication", "request"]
            : ["logical", "request"],
          sourceIds: ["vtadmin:tablets", "vtadmin:keyspaces"],
        });
        const cellId = tablet.cell
          ? externalId("cell", cluster.id, tablet.cell)
          : "";
        if (cellId && graph.nodeIds.has(cellId)) {
          addEdge(graph, {
            source: cellId,
            target: tabletId,
            type: "member-of-cell",
            label: "tablet",
            views: ["physical"],
            sourceIds: ["vtadmin:tablets"],
          });
        }
      }

      for (const shard of shards) {
        const primaryAlias = primaryAliasByShard.get(shard.name);
        if (!primaryAlias) continue;
        const primaryId = externalId("tablet", cluster.id, primaryAlias);
        for (const wrapper of keyspaceTablets) {
          const tablet = extractTablets([wrapper])[0];
          if (
            !tablet ||
            tablet.shard !== shard.name ||
            tablet.alias === primaryAlias ||
            !["REPLICA", "RDONLY"].includes(tablet.type)
          ) {
            continue;
          }
          addEdge(graph, {
            source: primaryId,
            target: externalId("tablet", cluster.id, tablet.alias),
            type: "replication-role",
            label: `serves ${tablet.type}`,
            views: ["replication"],
            confidence: "DERIVED",
            sourceIds: ["vtadmin:keyspaces", "vtadmin:tablets"],
          });
        }
      }

      const perCell = object(object(srvKeyspaces[keyspace]).srv_keyspaces);
      for (const [cell, srvRecord] of Object.entries(perCell)) {
        const servingId = externalId("serving", cluster.id, cell, keyspace);
        const refs = srvShardReferences(srvRecord);
        addNode(graph, {
          id: servingId,
          type: "servingGraph",
          label: `${cell} / ${keyspace}`,
          attributes: {
            "Cluster ID": cluster.id,
            Cell: cell,
            Keyspace: keyspace,
            "Shard references": refs
              .map((ref) => `${ref.name}:${ref.tabletType}`)
              .join(", "),
          },
          sourceIds: ["vtadmin:srvkeyspaces"],
        });
        addEdge(graph, {
          source: gatewayId,
          target: servingId,
          type: "reads-serving-graph",
          label: "reads",
          views: ["request"],
          sourceIds: ["vtadmin:srvkeyspaces"],
        });
        addEdge(graph, {
          source: servingId,
          target: keyspaceId,
          type: "resolves-keyspace",
          label: "resolves keyspace",
          views: ["request"],
          sourceIds: ["vtadmin:srvkeyspaces"],
        });
        for (const ref of refs) {
          addEdge(graph, {
            source: keyspaceId,
            target: externalId("shard", cluster.id, keyspace, ref.name),
            type: "serving-route",
            label: ref.tabletType,
            views: ["request"],
            sourceIds: ["vtadmin:srvkeyspaces"],
          });
        }
      }
    }
  }

  applyServiceHealth(graph.nodes, graph.edges);
  return { nodes: graph.nodes, edges: graph.edges, verified };
}

function clusterIdsFromNodes(nodes, localClusterId) {
  return [
    ...new Set(
      asArray(nodes)
        .map((node) => node?.attributes?.["Cluster ID"])
        .filter((id) => id && id !== localClusterId),
    ),
  ];
}

function degradedVtadminClusters(
  vtadminSources,
  previousCache,
  localClusterId,
) {
  if (!vtadminSources.length) return [];
  const sourceById = new Map(
    vtadminSources.map((source) => [source.id, source]),
  );
  const clustersSource = sourceById.get("vtadmin:clusters");
  const previousIds = clusterIdsFromNodes(
    previousCache?.nodes,
    localClusterId,
  );
  const currentIds =
    clustersSource?.status === "ok"
      ? asArray(vtadminResult(clustersSource, "clusters"))
          .map((cluster) => String(cluster?.id ?? ""))
          .filter((id) => id && id !== localClusterId)
      : previousIds;
  const sharedFailures = vtadminSources.filter(
    (source) =>
      source.status === "error" &&
      /^vtadmin:(clusters|keyspaces|tablets|vschemas|srvkeyspaces|vtctlds)$/.test(
        source.id,
      ),
  );

  return currentIds
    .map((clusterId) => {
      const healthSource = sourceById.get(
        `vtadmin:cluster:${safeId(clusterId)}:keyspaces`,
      );
      const failures = [
        ...sharedFailures,
        ...(healthSource?.status === "error" ? [healthSource] : []),
      ];
      if (!failures.length) return null;
      const primary = failures[0];
      return {
        id: clusterId,
        sourceId: primary.id,
        error: first(
          healthSource?.error,
          primary.error,
          "VTAdmin cluster query timed out",
        ),
        failedSourceIds: [...new Set(failures.map((source) => source.id))],
      };
    })
    .filter(Boolean);
}

export function retainUnavailableClusters({
  nodes,
  edges,
  previousCache,
  degradedClusters,
  collectedAt,
}) {
  const degradedById = new Map(
    degradedClusters.map((cluster) => [cluster.id, cluster]),
  );
  const markNode = (node, cluster) => ({
    ...node,
    status: "UNREACHABLE",
    attributes: {
      ...node.attributes,
      "Current observation": "UNREACHABLE · 마지막 정상 관계 유지",
      Failure: cluster.error,
      "Failure source": cluster.sourceId,
      "Last successful observation":
        previousCache?.collectedAt ?? "not available",
      "Failure observed at": collectedAt,
    },
    sourceIds: [
      ...new Set([...(node.sourceIds ?? []), ...cluster.failedSourceIds]),
    ],
  });

  const mergedNodes = nodes.map((node) => {
    const cluster = degradedById.get(node.attributes?.["Cluster ID"]);
    return cluster ? markNode(node, cluster) : node;
  });
  const nodeIds = new Set(mergedNodes.map((node) => node.id));
  for (const cachedNode of previousCache?.nodes ?? []) {
    const cluster = degradedById.get(
      cachedNode.attributes?.["Cluster ID"],
    );
    if (!cluster || nodeIds.has(cachedNode.id)) continue;
    mergedNodes.push(markNode(cachedNode, cluster));
    nodeIds.add(cachedNode.id);
  }

  const nodeById = new Map(mergedNodes.map((node) => [node.id, node]));
  const isFaultEdge = (edge) =>
    [edge.source, edge.target].some(
      (id) => nodeById.get(id)?.status === "UNREACHABLE",
    );
  const markEdge = (edge) =>
    isFaultEdge(edge)
      ? {
          ...edge,
          status: "UNREACHABLE",
          failure: "연결 대상 조회 실패 · 마지막 정상 관계 유지",
        }
      : edge;
  const mergedEdges = edges.map(markEdge);
  const edgeIds = new Set(mergedEdges.map((edge) => edge.id));
  for (const cachedEdge of previousCache?.edges ?? []) {
    if (
      edgeIds.has(cachedEdge.id) ||
      !nodeIds.has(cachedEdge.source) ||
      !nodeIds.has(cachedEdge.target) ||
      !isFaultEdge(cachedEdge)
    ) {
      continue;
    }
    mergedEdges.push(markEdge(cachedEdge));
    edgeIds.add(cachedEdge.id);
  }

  return {
    nodes: mergedNodes,
    edges: mergedEdges,
    degradedClusters: degradedClusters.map((cluster) => ({
      ...cluster,
      lastSuccessfulAt: previousCache?.collectedAt,
      retainedNodes: mergedNodes.filter(
        (node) =>
          node.attributes?.["Cluster ID"] === cluster.id &&
          node.status === "UNREACHABLE",
      ).length,
    })),
  };
}

function applyServiceHealth(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const markCritical = (node, reason) => {
    if (!node || node.status === "UNREACHABLE") return;
    node.status = "CRITICAL";
    node.attributes = {
      ...node.attributes,
      "Health reason": reason,
    };
  };

  for (const shard of nodes.filter((node) => node.type === "shard")) {
    const primaryEdges = edges.filter(
      (edge) => edge.source === shard.id && edge.type === "primary",
    );
    const primaryNodes = primaryEdges
      .map((edge) => nodeById.get(edge.target))
      .filter(Boolean);
    if (
      !primaryEdges.length ||
      primaryNodes.some((node) =>
        ["CRITICAL", "ERROR", "UNREACHABLE"].includes(node.status),
      ) ||
      String(shard.attributes?.Serving).toLowerCase() === "false"
    ) {
      markCritical(shard, "Primary 부재 또는 Primary serving 중단");
    }
  }

  for (const keyspace of nodes.filter((node) => node.type === "keyspace")) {
    const shards = edges
      .filter((edge) => edge.source === keyspace.id)
      .map((edge) => nodeById.get(edge.target))
      .filter((node) => node?.type === "shard");
    if (shards.some((node) => node.status === "CRITICAL")) {
      markCritical(keyspace, "하위 Shard의 Primary 서비스 영향");
    }
  }

  for (const cluster of nodes.filter((node) => node.type === "cluster")) {
    const keyspaces = edges
      .filter((edge) => edge.source === cluster.id)
      .map((edge) => nodeById.get(edge.target))
      .filter((node) => node?.type === "keyspace");
    if (keyspaces.some((node) => node.status === "CRITICAL")) {
      markCritical(cluster, "하위 Keyspace에 서비스 영향 장애 존재");
    }
  }
}

export function defaultConfig(overrides = {}) {
  return {
    vtctldclientPath:
      process.env.VTV_VTCTLDCLIENT ?? "/opt/vitess/current/bin/vtctldclient",
    vtctldAddress:
      process.env.VTV_VTCTLD_ADDRESS ?? "127.0.0.1:15999",
    startScript: process.env.VTV_START_SCRIPT ?? "",
    commandTimeoutMs: Number(process.env.VTV_COMMAND_TIMEOUT_MS ?? 4000),
    httpTimeoutMs: Number(process.env.VTV_HTTP_TIMEOUT_MS ?? 2500),
    cacheFile:
      process.env.VTV_CACHE_FILE ?? path.join(projectDir, "var", "last-good.json"),
    cacheMaxAgeMs: Number(process.env.VTV_CACHE_MAX_AGE_MS ?? 300000),
    vtadminApiUrl: process.env.VTV_VTADMIN_API ?? "",
    vtadminLocalClusterId: process.env.VTV_VTADMIN_LOCAL_CLUSTER_ID ?? "local",
    managedClusterFile:
      process.env.VTV_MANAGED_CLUSTER_FILE ??
      path.join(projectDir, "var", "managed-clusters.json"),
    ...overrides,
  };
}

export class TopologyCollector {
  constructor(config = defaultConfig()) {
    this.config = config;
    this.lastRawSources = new Map();
  }

  async collect() {
    const collectionStarted = performance.now();
    const collectedAt = nowIso();
    const config = this.config;
    const sources = [];
    const graph = newGraph();

    const [
      scriptResult,
      processes,
      versionSource,
      listenerSource,
      installedComponents,
      vtadminSources,
    ] =
      await Promise.all([
        readStartScript(config.startScript),
        discoverProcesses(),
        collectExecSource({
          id: "install:version",
          label: "Installed vtctldclient version",
          file: config.vtctldclientPath,
          args: ["--version"],
          timeoutMs: config.commandTimeoutMs,
        }),
        collectExecSource({
          id: "system:listeners",
          label: "Listening TCP ports",
          file: "/bin/netstat",
          args: ["-lntp"],
          timeoutMs: config.commandTimeoutMs,
        }),
        discoverInstalledComponents(config.vtctldclientPath),
        collectVtadminSources(config),
      ]);
    const installedSource = sourceRecord({
      id: "install:components",
      label: "Installed Vitess components",
      kind: "filesystem",
      status: "ok",
      startedAt: collectedAt,
      durationMs: 0,
      raw: installedComponents,
    });
    sources.push(
      scriptResult.source,
      versionSource,
      installedSource,
      listenerSource,
      ...vtadminSources,
    );

    const versionText = String(versionSource.raw ?? "");
    const version = versionText.match(/Version:\s*([^\s]+)/)?.[1] ?? "UNKNOWN";
    const revision = versionText.match(/Git revision\s+([^\s)]+)/)?.[1];
    const installPath = await readlink(
      path.dirname(path.dirname(config.vtctldclientPath)),
    ).catch(() => path.dirname(path.dirname(config.vtctldclientPath)));
    const hostname = os.hostname();
    const hostId = `host:${safeId(hostname)}`;
    const clusterId = `cluster:${safeId(hostname)}`;
    addNode(graph, {
      id: hostId,
      type: "host",
      label: hostname,
      status: "HEALTHY",
      attributes: {
        Hostname: hostname,
        Platform: `${os.type()} ${os.release()}`,
        Architecture: os.arch(),
      },
      sourceIds: ["system:processes"],
    });
    addNode(graph, {
      id: clusterId,
      type: "cluster",
      label: version === "UNKNOWN" ? "Vitess installation" : `Vitess ${version}`,
      status: versionSource.status === "ok" ? "HEALTHY" : "UNKNOWN",
      attributes: {
        "Cluster ID": config.vtadminLocalClusterId,
        Version: version,
        Revision: revision ?? "UNKNOWN",
        "Install path": installPath,
        "Configured topology": scriptResult.config.topologyImplementation ?? "UNKNOWN",
        "Configured cell": scriptResult.config.exports?.CELL ?? "UNKNOWN",
        "Configured vtctld": config.vtctldAddress,
        "Installed components": installedComponents
          .filter((component) => component.installed)
          .map((component) => component.name)
          .join(", "),
        "Runtime state": processes.some((item) => PROCESS_TYPES.has(item.name))
          ? "Vitess processes detected"
          : "No Vitess process detected",
      },
      sourceIds: ["install:version", "config:start-script", "system:processes"],
    });
    addEdge(graph, {
      source: hostId,
      target: clusterId,
      type: "hosts",
      label: "hosts installation",
      views: ["physical"],
      sourceIds: ["install:version"],
    });

    const listenerByPid = parseNetstat(listenerSource.raw);
    const processSource = sourceRecord({
      id: "system:processes",
      label: "Running Vitess processes",
      kind: "procfs",
      status: "ok",
      startedAt: collectedAt,
      durationMs: 0,
      raw: processes.map(({ rawArgs, ...item }) => ({
        ...item,
        args: redactArgs(rawArgs),
      })),
    });
    sources.push(processSource);

    const processNodeByTabletAlias = new Map();
    const mysqlNodeByTabletUid = new Map();
    const gatewayNodesByCell = new Map();
    let vtgateMySQLPort;
    for (const info of processes) {
      const listeners = listenerByPid.get(info.pid) ?? [];
      const id = `process:${info.name}:${info.pid}`;
      const status = "HEALTHY";
      addNode(graph, {
        id,
        type: info.componentType,
        label: processDisplayName(info),
        status,
        attributes: processAttributes(info, listeners),
        sourceIds: ["system:processes", "system:listeners"],
      });
      addEdge(graph, {
        source: clusterId,
        target: id,
        type: "component",
        label: typeLabel(info.componentType),
        views: ["physical"],
        sourceIds: ["system:processes"],
      });
      const alias = flagValue(info.rawArgs, "tablet-path", "tablet_path");
      if (alias) processNodeByTabletAlias.set(alias, id);
      if (info.name === "mysqld") {
        const uid = info.rawArgs
          .join(" ")
          .match(/\/vt\/vtdataroot\/vt_(\d{10})\//)?.[1];
        if (uid) mysqlNodeByTabletUid.set(uid, id);
      }
      if (info.name === "vtgate") {
        const cell = flagValue(info.rawArgs, "cell") ?? "UNKNOWN";
        vtgateMySQLPort = Number(
          flagValue(info.rawArgs, "mysql-server-port", "mysql_server_port"),
        );
        const list = gatewayNodesByCell.get(cell) ?? [];
        list.push(id);
        gatewayNodesByCell.set(cell, list);
      }
    }

    const runningNames = new Set(processes.map((processInfo) => processInfo.name));
    for (const component of installedComponents) {
      if (
        !component.installed ||
        !component.graphWhenStopped ||
        runningNames.has(component.name)
      ) {
        continue;
      }
      const id = `installed:${component.name}`;
      addNode(graph, {
        id,
        type: component.type,
        label: `${component.name} · not running`,
        status: "NOT_RUNNING",
        attributes: {
          Component: component.name,
          Installed: "yes",
          Running: "no",
          Executable: component.executable,
          Version: component.name === "etcd" ? "3.6.6" : version,
          "Listen ports": "none",
        },
        sourceIds: ["install:components", "system:processes", "system:listeners"],
      });
      addEdge(graph, {
        source: clusterId,
        target: id,
        type: "installed-component",
        label: "installed / stopped",
        views: ["physical"],
        sourceIds: ["install:components", "system:processes"],
      });
    }

    let vtgateKeyspacesSource;
    let vtgateTabletsSource;
    let vtgateTabletRows = [];
    if (Number.isFinite(vtgateMySQLPort)) {
      [vtgateKeyspacesSource, vtgateTabletsSource] = await Promise.all([
        collectExecSource({
          id: "vtgate:keyspaces",
          label: "VTGate SHOW VITESS_KEYSPACES",
          file: "/usr/bin/mysql",
          args: [
            "--no-defaults",
            "--protocol=tcp",
            "-h",
            "127.0.0.1",
            "-P",
            String(vtgateMySQLPort),
            "--batch",
            "--raw",
            "--skip-column-names",
            "-e",
            "show vitess_keyspaces",
          ],
          timeoutMs: config.commandTimeoutMs,
        }),
        collectExecSource({
          id: "vtgate:tablets",
          label: "VTGate SHOW VITESS_TABLETS",
          file: "/usr/bin/mysql",
          args: [
            "--no-defaults",
            "--protocol=tcp",
            "-h",
            "127.0.0.1",
            "-P",
            String(vtgateMySQLPort),
            "--batch",
            "--raw",
            "--skip-column-names",
            "-e",
            "show vitess_tablets",
          ],
          timeoutMs: config.commandTimeoutMs,
        }),
      ]);
      sources.push(vtgateKeyspacesSource, vtgateTabletsSource);
      if (vtgateTabletsSource.status === "ok") {
        vtgateTabletRows = parseVtgateTablets(vtgateTabletsSource.raw);
      }
    }

    const liveVitessProcesses = processes.filter((item) =>
      PROCESS_TYPES.has(item.name),
    );
    const componentHttpSources = [];
    for (const info of liveVitessProcesses) {
      if (!["vtctld", "vtgate", "vttablet", "vtorc", "vtadmin", "vtadmin-api"].includes(info.name)) {
        continue;
      }
      const port = Number(flagValue(info.rawArgs, "port"));
      if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
      componentHttpSources.push(
        collectHttpSource({
          id: `http:${info.name}:${info.pid}:vars`,
          label: `${info.name} /debug/vars`,
          endpoint: `http://127.0.0.1:${port}/debug/vars`,
          timeoutMs: config.httpTimeoutMs,
        }),
      );
      componentHttpSources.push(
        collectHttpSource({
          id: `http:${info.name}:${info.pid}:status`,
          label: `${info.name} /debug/status`,
          endpoint: `http://127.0.0.1:${port}/debug/status`,
          timeoutMs: config.httpTimeoutMs,
        }),
      );
    }
    sources.push(...(await Promise.all(componentHttpSources)));

    const keyspaceSource = await vtclientSource(
      config,
      "vtctld:keyspaces",
      "vtctld GetKeyspaces",
      ["GetKeyspaces"],
    );
    sources.push(keyspaceSource);

    const verified = {
      cells: [],
      keyspaces: [],
      shards: [],
      tablets: [],
      primaries: [],
      workflows: [],
    };
    const verification = [];
    const pendingEdges = [];

    if (keyspaceSource.status === "ok") {
      const cellSource = await vtclientSource(
        config,
        "vtctld:cells",
        "vtctld GetCellInfoNames",
        ["GetCellInfoNames"],
      );
      sources.push(cellSource);
      const cells = [
        ...extractNamesFromResponse(commandRawJson(cellSource), "cells"),
        ...(typeof cellSource.raw === "string"
          ? cellSource.raw.split(/\r?\n/).map((cell) => cell.trim())
          : []),
      ].filter((cell) => CELL_RE.test(cell));
      verified.cells = [...new Set(cells)];
      for (const cell of verified.cells) {
        const cellId = `cell:${safeId(cell)}`;
        addNode(graph, {
          id: cellId,
          type: "cell",
          label: cell,
          attributes: {
            Cell: cell,
            "Cluster ID": config.vtadminLocalClusterId,
          },
          sourceIds: ["vtctld:cells"],
        });
        addEdge(graph, {
          source: clusterId,
          target: cellId,
          type: "contains",
          label: "cell",
          views: ["logical", "physical"],
          sourceIds: ["vtctld:cells"],
        });
      }

      const keyspaceNames = extractKeyspaceNames(commandRawJson(keyspaceSource));
      verified.keyspaces = keyspaceNames;
      if (vtgateKeyspacesSource?.status === "ok") {
        const vtgateKeyspaces = String(vtgateKeyspacesSource.raw)
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => KEYSPACE_RE.test(name))
          .sort();
        verification.push({
          check: "keyspaces-vtctld-vs-vtgate",
          target: "cluster",
          status:
            JSON.stringify([...keyspaceNames].sort()) === JSON.stringify(vtgateKeyspaces)
              ? "MATCH"
              : "MISMATCH",
          vtctld: [...keyspaceNames].sort(),
          vtgate: vtgateKeyspaces,
          sources: ["vtctld:keyspaces", "vtgate:keyspaces"],
        });
      }
      const keyspaceBundles = await Promise.all(
        keyspaceNames.map(async (keyspace) => {
          const [detail, shards, tablets, vschema, serving, workflows] =
            await Promise.all([
              vtclientSource(
                config,
                `vtctld:keyspace:${safeId(keyspace)}`,
                `vtctld GetKeyspace ${keyspace}`,
                ["GetKeyspace", keyspace],
              ),
              vtclientSource(
                config,
                `vtctld:shards:${safeId(keyspace)}`,
                `vtctld FindAllShardsInKeyspace ${keyspace}`,
                ["FindAllShardsInKeyspace", keyspace],
              ),
              vtclientSource(
                config,
                `vtctld:tablets:${safeId(keyspace)}`,
                `vtctld GetTablets ${keyspace}`,
                ["GetTablets", "--keyspace", keyspace, "--format", "json"],
              ),
              vtclientSource(
                config,
                `vtctld:vschema:${safeId(keyspace)}`,
                `vtctld GetVSchema ${keyspace}`,
                ["GetVSchema", keyspace],
              ),
              vtclientSource(
                config,
                `vtctld:serving:${safeId(keyspace)}`,
                `vtctld GetSrvKeyspaces ${keyspace}`,
                ["GetSrvKeyspaces", keyspace],
              ),
              vtclientSource(
                config,
                `vtctld:workflows:${safeId(keyspace)}`,
                `vtctld GetWorkflows ${keyspace}`,
                ["GetWorkflows", "--include-logs=false", keyspace],
              ),
            ]);
          return { keyspace, detail, shards, tablets, vschema, serving, workflows };
        }),
      );

      for (const bundle of keyspaceBundles) {
        sources.push(
          bundle.detail,
          bundle.shards,
          bundle.tablets,
          bundle.vschema,
          bundle.serving,
          bundle.workflows,
        );
        const keyspace = bundle.keyspace;
        const ksId = `keyspace:${safeId(keyspace)}`;
        const detailJson = commandRawJson(bundle.detail);
        addNode(graph, {
          id: ksId,
          type: "keyspace",
          label: keyspace,
          status: bundle.detail.status === "ok" ? "HEALTHY" : "UNKNOWN",
          attributes: {
            "Cluster ID": config.vtadminLocalClusterId,
            Keyspace: keyspace,
            Durability: first(
              detailJson?.keyspace?.durabilityPolicy,
              detailJson?.keyspace?.durability_policy,
              detailJson?.durabilityPolicy,
              detailJson?.durability_policy,
              "UNKNOWN",
            ),
          },
          sourceIds: ["vtctld:keyspaces", bundle.detail.id],
        });
        addEdge(graph, {
          source: clusterId,
          target: ksId,
          type: "contains",
          label: "keyspace",
          views: ["logical"],
          sourceIds: ["vtctld:keyspaces"],
        });

        let shardingMode = "UNKNOWN";
        if (bundle.vschema.status === "ok") {
          const vschemaJson = commandRawJson(bundle.vschema);
          shardingMode = vschemaJson?.sharded
            ? "SHARDED"
            : "UNSHARDED";
          const keyspaceNode = graph.nodes.find((node) => node.id === ksId);
          if (keyspaceNode) {
            keyspaceNode.attributes.Sharding =
              shardingMode === "SHARDED" ? "SHARDED (샤딩)" : "UNSHARDED (노샤딩)";
            keyspaceNode.attributes["VSchema tables"] = Object.keys(
              object(vschemaJson?.tables),
            ).length;
            keyspaceNode.attributes["VSchema vindexes"] = Object.keys(
              object(vschemaJson?.vindexes),
            ).length;
            keyspaceNode.sourceIds.push(bundle.vschema.id);
          }
          const vsId = `vschema:${safeId(keyspace)}`;
          addNode(graph, {
            id: vsId,
            type: "vschema",
            label: `${keyspace} VSchema`,
            attributes: {
              "Cluster ID": config.vtadminLocalClusterId,
              Keyspace: keyspace,
              Sharded: first(vschemaJson?.sharded, false),
              Tables: Object.keys(object(vschemaJson?.tables)).length,
              Vindexes: Object.keys(object(vschemaJson?.vindexes)).length,
            },
            sourceIds: [bundle.vschema.id],
          });
          addEdge(graph, {
            source: ksId,
            target: vsId,
            type: "described-by",
            label: "VSchema",
            views: ["logical"],
            sourceIds: [bundle.vschema.id],
          });
        }

        const shards = extractShards(commandRawJson(bundle.shards));
        const keyspaceNode = graph.nodes.find((node) => node.id === ksId);
        if (keyspaceNode) {
          keyspaceNode.attributes["Partition count"] = shards.length;
          keyspaceNode.attributes["Partition layout"] =
            shardingMode === "UNSHARDED"
              ? "1 unsharded partition (topology shard 0)"
              : shards.map((shard) => shard.name).join(", ");
        }
        for (const shard of shards) {
          verified.shards.push({
            keyspace,
            shard: shard.name,
            keyRange: shard.keyRange,
            sharding: shardingMode,
          });
          if (shard.primaryAlias) {
            verified.primaries.push({
              keyspace,
              shard: shard.name,
              alias: shard.primaryAlias,
            });
          }
          const shardId = `shard:${safeId(keyspace)}:${safeId(shard.name)}`;
          const isUnshardedPartition =
            shardingMode === "UNSHARDED" && shard.name === "0";
          addNode(graph, {
            id: shardId,
            type: "shard",
            label: isUnshardedPartition ? "노샤딩 · 단일 파티션" : shard.name,
            status:
              shard.primaryAlias && shard.isPrimaryServing !== false
                ? "HEALTHY"
                : "CRITICAL",
            attributes: {
              Keyspace: keyspace,
              Shard: shard.name,
              "Key range": isUnshardedPartition
                ? "N/A (unsharded)"
                : shard.keyRange,
              Sharding: isUnshardedPartition
                ? "UNSHARDED (노샤딩)"
                : shardingMode === "SHARDED"
                  ? "SHARDED (샤딩)"
                  : "UNKNOWN",
              "Topology record": isUnshardedPartition
                ? "shard 0 (internal representation)"
                : `shard ${shard.name}`,
              "Primary alias": shard.primaryAlias || "UNKNOWN",
              Serving:
                shard.isPrimaryServing === undefined
                  ? "UNKNOWN"
                  : String(shard.isPrimaryServing),
            },
            sourceIds: [bundle.shards.id],
          });
          addEdge(graph, {
            source: ksId,
            target: shardId,
            type: "contains",
            label: isUnshardedPartition ? "unsharded partition" : "shard",
            views: ["logical", "replication"],
            sourceIds: [bundle.shards.id],
          });
        }

        const tablets = extractTablets(commandRawJson(bundle.tablets));
        for (const tablet of tablets) {
          if (!KEYSPACE_RE.test(tablet.keyspace) || !SHARD_RE.test(tablet.shard)) {
            continue;
          }
          verified.tablets.push({
            alias: tablet.alias,
            cell: tablet.cell,
            keyspace: tablet.keyspace,
            shard: tablet.shard,
            type: tablet.type,
          });
          const tabletId = `tablet:${safeId(tablet.alias)}`;
          const shardId = `shard:${safeId(tablet.keyspace)}:${safeId(tablet.shard)}`;
          const cellId = tablet.cell ? `cell:${safeId(tablet.cell)}` : "";
          const primaryMatch = verified.primaries.some(
            (primary) =>
              primary.keyspace === tablet.keyspace &&
              primary.shard === tablet.shard &&
              primary.alias === tablet.alias,
          );
          const vtgateRow = vtgateTabletRows.find(
            (row) => row.alias === tablet.alias,
          );
          if (vtgateRow) {
            tablet.servingState = vtgateRow.state;
            verification.push({
              check: "tablet-vtctld-vs-vtgate",
              target: tablet.alias,
              status:
                vtgateRow.keyspace === tablet.keyspace &&
                vtgateRow.shard === tablet.shard &&
                vtgateRow.tabletType === tablet.type
                  ? "MATCH"
                  : "MISMATCH",
              sources: [bundle.tablets.id, "vtgate:tablets"],
            });
          }
          addNode(graph, {
            id: tabletId,
            type: "tablet",
            label: tablet.alias,
            status:
              !tablet.servingState ||
              String(tablet.servingState).toUpperCase() === "UNKNOWN"
                ? "UNKNOWN"
                : String(tablet.servingState).toUpperCase().includes("NOT")
                  ? tablet.type === "PRIMARY"
                    ? "CRITICAL"
                    : "DEGRADED"
                  : "HEALTHY",
            attributes: {
              "Cluster ID": config.vtadminLocalClusterId,
              Alias: tablet.alias,
              Cell: tablet.cell ?? "UNKNOWN",
              Keyspace: tablet.keyspace,
              Shard: tablet.shard,
              "Tablet type": tablet.type,
              Primary: primaryMatch ? "yes" : "no",
              Hostname: tablet.hostname ?? "UNKNOWN",
              "MySQL hostname": tablet.mysqlHostname ?? "UNKNOWN",
              "MySQL port": tablet.mysqlPort ?? "UNKNOWN",
              Ports: Object.entries(tablet.ports)
                .map(([name, port]) => `${name}:${port}`)
                .join(", "),
              Serving: tablet.servingState ?? "UNKNOWN",
            },
            sourceIds: [
              bundle.tablets.id,
              bundle.shards.id,
              ...(vtgateRow ? ["vtgate:tablets"] : []),
            ],
          });
          addEdge(graph, {
            source: shardId,
            target: tabletId,
            type: primaryMatch ? "primary" : "tablet",
            label: primaryMatch ? "PRIMARY" : tablet.type,
            views: primaryMatch
              ? ["logical", "replication", "request"]
              : ["logical", "request"],
            sourceIds: [bundle.tablets.id, bundle.shards.id],
          });
          if (cellId && graph.nodeIds.has(cellId)) {
            addEdge(graph, {
              source: cellId,
              target: tabletId,
              type: "member-of-cell",
              label: "cell member",
              views: ["physical"],
              sourceIds: [bundle.tablets.id, "vtctld:cells"],
            });
          }
          const processNode = processNodeByTabletAlias.get(tablet.alias);
          if (processNode) {
            addEdge(graph, {
              source: processNode,
              target: tabletId,
              type: "represents",
              label: "runtime",
              views: ["physical"],
              sourceIds: ["system:processes", bundle.tablets.id],
            });
            verification.push({
              check: "tablet-process-alias",
              target: tablet.alias,
              status: "MATCH",
              sources: ["system:processes", bundle.tablets.id],
            });
          }
          const uid = tablet.alias.match(/(\d{10})$/)?.[1];
          const mysqlNode = uid ? mysqlNodeByTabletUid.get(uid) : undefined;
          if (mysqlNode) {
            addEdge(graph, {
              source: tabletId,
              target: mysqlNode,
              type: "backed-by",
              label: "MySQL",
              views: ["physical"],
              sourceIds: [bundle.tablets.id, "system:processes"],
            });
          }
        }

        for (const shard of shards) {
          const primaryId = shard.primaryAlias
            ? `tablet:${safeId(shard.primaryAlias)}`
            : "";
          if (!primaryId || !graph.nodeIds.has(primaryId)) continue;
          for (const tablet of tablets.filter(
            (item) =>
              item.keyspace === keyspace &&
              item.shard === shard.name &&
              item.alias !== shard.primaryAlias &&
              ["REPLICA", "RDONLY"].includes(item.type),
          )) {
            addEdge(graph, {
              source: primaryId,
              target: `tablet:${safeId(tablet.alias)}`,
              type: "replication-role",
              label: `serves ${tablet.type}`,
              views: ["replication"],
              confidence: "DERIVED",
              sourceIds: [bundle.shards.id, bundle.tablets.id],
            });
          }
        }

        if (bundle.serving.status === "ok") {
          for (const [cell, srvRecord] of srvEntries(commandRawJson(bundle.serving))) {
            const servingId = `serving:${safeId(cell)}:${safeId(keyspace)}`;
            const refs = srvShardReferences(srvRecord);
            addNode(graph, {
              id: servingId,
              type: "servingGraph",
              label: `${cell} / ${keyspace}`,
              attributes: {
                "Cluster ID": config.vtadminLocalClusterId,
                Cell: cell,
                Keyspace: keyspace,
                "Shard references": refs.map((ref) => `${ref.name}:${ref.tabletType}`).join(", "),
              },
              sourceIds: [bundle.serving.id],
            });
            addEdge(graph, {
              source: servingId,
              target: ksId,
              type: "resolves-keyspace",
              label: "resolves keyspace",
              views: ["request"],
              sourceIds: [bundle.serving.id],
            });
            for (const gatewayId of [
              ...(gatewayNodesByCell.get(cell) ?? []),
              ...(gatewayNodesByCell.get("UNKNOWN") ?? []),
            ]) {
              addEdge(graph, {
                source: gatewayId,
                target: servingId,
                type: "reads-serving-graph",
                label: "reads",
                views: ["request"],
                sourceIds: ["system:processes", bundle.serving.id],
              });
            }
            for (const ref of refs) {
              addEdge(graph, {
                source: ksId,
                target: `shard:${safeId(keyspace)}:${safeId(ref.name)}`,
                type: "serving-route",
                label: ref.tabletType,
                views: ["request"],
                sourceIds: [bundle.serving.id],
              });
            }
          }
        }

        if (bundle.workflows.status === "ok") {
          for (const [index, workflow] of workflowValues(
            commandRawJson(bundle.workflows),
          ).entries()) {
            const name = String(first(workflow.name, workflow.workflow, `workflow-${index + 1}`));
            verified.workflows.push({ keyspace, name });
            const wfId = `workflow:${safeId(keyspace)}:${safeId(name)}`;
            const streamStates = Object.values(object(workflow.shard_streams))
              .flatMap((group) => asArray(group?.streams))
              .map((stream) => String(first(stream?.state, "UNKNOWN")));
            const streamMessages = Object.values(object(workflow.shard_streams))
              .flatMap((group) => asArray(group?.streams))
              .map((stream) => stream?.message)
              .filter(Boolean);
            const sourceKeyspace = first(
              workflow.source?.keyspace,
              workflow.source_keyspace,
            );
            const targetKeyspace = first(
              workflow.target?.keyspace,
              workflow.target_keyspace,
              keyspace,
            );
            addNode(graph, {
              id: wfId,
              type: "workflow",
              label: name,
              status: streamStates.some((state) => state.toUpperCase() === "ERROR")
                ? "DEGRADED"
                : "HEALTHY",
              attributes: {
                "Cluster ID": config.vtadminLocalClusterId,
                Keyspace: keyspace,
                Workflow: name,
                Type: first(workflow.workflowType, workflow.workflow_type, "UNKNOWN"),
                State: first(
                  workflow.state,
                  workflow.status,
                  [...new Set(streamStates)].join(", "),
                  "UNKNOWN",
                ),
                Source: sourceKeyspace ?? "UNKNOWN",
                Target: targetKeyspace ?? "UNKNOWN",
                "Target shards": asArray(workflow.target?.shards).join(", "),
                Message: streamMessages[0] ?? "",
              },
              sourceIds: [bundle.workflows.id],
            });
            if (sourceKeyspace) {
              pendingEdges.push({
                source: wfId,
                target: `keyspace:${safeId(sourceKeyspace)}`,
                type: "workflow-source",
                label: "SOURCE",
                views: ["replication"],
                sourceIds: [bundle.workflows.id],
              });
            }
            if (targetKeyspace) {
              pendingEdges.push({
                source: wfId,
                target: `keyspace:${safeId(targetKeyspace)}`,
                type: "workflow-target-keyspace",
                label: "TARGET",
                views: ["replication"],
                sourceIds: [bundle.workflows.id],
              });
            }
          }
        }
      }
      for (const edge of pendingEdges) addEdge(graph, edge);
    }

    if (vtadminSources.length) {
      const sourceById = new Map(
        vtadminSources.map((source) => [source.id, source]),
      );
      const external = buildExternalVtadminTopology(
        {
          clusters: vtadminResult(sourceById.get("vtadmin:clusters"), "clusters"),
          keyspaces: vtadminResult(
            sourceById.get("vtadmin:keyspaces"),
            "keyspaces",
          ),
          tablets: vtadminResult(sourceById.get("vtadmin:tablets"), "tablets"),
          vschemas: vtadminResult(
            sourceById.get("vtadmin:vschemas"),
            "v_schemas",
          ),
          srvKeyspaces: vtadminResult(
            sourceById.get("vtadmin:srvkeyspaces"),
            "srv_keyspaces",
          ),
          vtctlds: vtadminResult(sourceById.get("vtadmin:vtctlds"), "vtctlds"),
        },
        { localClusterId: config.vtadminLocalClusterId },
      );
      for (const node of external.nodes) addNode(graph, node);
      for (const edge of external.edges) addEdge(graph, edge);
      for (const key of Object.keys(verified)) {
        verified[key].push(...(external.verified[key] ?? []));
      }
      verified.cells = [...new Set(verified.cells)];
      verified.keyspaces = [...new Set(verified.keyspaces)];
    }

    applyServiceHealth(graph.nodes, graph.edges);

    const liveTopology = keyspaceSource.status === "ok";
    const previousCache = await this.readCache();
    let nodes = graph.nodes;
    let edges = graph.edges;
    let stale = false;
    let cacheAgeMs;
    let lastSuccessfulAt;
    let rawSourcesForResponse = sources;
    let degradedClusters = degradedVtadminClusters(
      vtadminSources,
      previousCache,
      config.vtadminLocalClusterId,
    );

    if (degradedClusters.length) {
      const retained = retainUnavailableClusters({
        nodes,
        edges,
        previousCache,
        degradedClusters,
        collectedAt,
      });
      nodes = retained.nodes;
      edges = retained.edges;
      degradedClusters = retained.degradedClusters;
      lastSuccessfulAt = previousCache?.collectedAt;
      if (lastSuccessfulAt) {
        cacheAgeMs = Date.now() - Date.parse(lastSuccessfulAt);
      }
    }

    if (liveTopology && !degradedClusters.length) {
      lastSuccessfulAt = collectedAt;
      const cachePayload = {
        schemaVersion: 1,
        collectedAt,
        nodes,
        edges,
        verified,
        sources,
        verification,
      };
      await this.writeCache(cachePayload);
    } else if (!liveTopology) {
      stale = Boolean(previousCache?.nodes?.length);
      lastSuccessfulAt = previousCache?.collectedAt;
      if (lastSuccessfulAt) {
        cacheAgeMs = Date.now() - Date.parse(lastSuccessfulAt);
      }
      const retained = retainUnavailableClusters({
        nodes,
        edges,
        previousCache,
        degradedClusters: [
          {
            id: config.vtadminLocalClusterId,
            sourceId: keyspaceSource.id,
            error: keyspaceSource.error ?? "local vtctld query failed",
            failedSourceIds: [keyspaceSource.id],
          },
        ],
        collectedAt,
      });
      nodes = retained.nodes;
      edges = retained.edges;
      if (previousCache?.nodes?.length) {
        verified.keyspaces = previousCache.verified?.keyspaces ?? [];
        verified.shards = previousCache.verified?.shards ?? [];
        verified.tablets = previousCache.verified?.tablets ?? [];
        verified.primaries = previousCache.verified?.primaries ?? [];
        rawSourcesForResponse = [
          ...sources,
          ...(previousCache.sources ?? []).map((source) => ({
            ...source,
            id: `cache:${source.id}`,
            status: "stale",
          })),
        ];
      }
    }

    const issues = validateGraph({ nodes, edges });
    const failedSources = sources.filter((source) => source.status === "error");
    const overallStatus = liveTopology
      ? failedSources.length || degradedClusters.length
        ? "PARTIAL"
        : "HEALTHY"
      : stale
        ? "STALE"
        : "OFFLINE";

    const response = {
      schemaVersion: 1,
      collectedAt,
      durationMs: Math.round(performance.now() - collectionStarted),
      overallStatus,
      readOnly: true,
      cache: {
        stale,
        degradedClusters,
        lastSuccessfulAt,
        ageMs: cacheAgeMs,
        beyondMaxAge:
          cacheAgeMs !== undefined ? cacheAgeMs > config.cacheMaxAgeMs : false,
      },
      environment: {
        hostname,
        platform: `${os.type()} ${os.release()}`,
        architecture: os.arch(),
        vitessVersion: version,
        revision,
        installPath,
        vtctldAddress: config.vtctldAddress,
        vtadminApiUrl: config.vtadminApiUrl || undefined,
        startScript: config.startScript,
        configured: scriptResult.config,
        liveVitessProcesses: liveVitessProcesses.length,
      },
      summary: {
        nodes: nodes.length,
        edges: edges.length,
        cells: nodes.filter((node) => node.type === "cell").length,
        keyspaces: nodes.filter((node) => node.type === "keyspace").length,
        shards: nodes.filter((node) => node.type === "shard").length,
        tablets: nodes.filter((node) => node.type === "tablet").length,
        workflows: nodes.filter((node) => node.type === "workflow").length,
        failedSources: failedSources.length,
      },
      nodes,
      edges,
      verified,
      verification,
      sourceSummaries: rawSourcesForResponse.map(({ raw, ...source }) => ({
        ...source,
        rawAvailable:
          raw !== undefined && raw !== null && String(raw).length > 0,
      })),
      errors: failedSources.map((source) => ({
        sourceId: source.id,
        label: source.label,
        error: source.error,
      })),
      validation: {
        passed: issues.length === 0,
        issues,
      },
    };

    this.lastRawSources = new Map(
      rawSourcesForResponse.map((source) => [
        source.id,
        {
          id: source.id,
          label: source.label,
          status: source.status,
          collectedAt: source.collectedAt,
          command: source.command,
          endpoint: source.endpoint,
          error: source.error,
          raw: source.raw,
        },
      ]),
    );
    return response;
  }

  rawSource(id) {
    return this.lastRawSources.get(id);
  }

  async readCache() {
    try {
      return JSON.parse(await readFile(this.config.cacheFile, "utf8"));
    } catch {
      return null;
    }
  }

  async writeCache(payload) {
    try {
      await mkdir(path.dirname(this.config.cacheFile), { recursive: true });
      await writeFile(
        this.config.cacheFile,
        `${JSON.stringify(payload, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Cache failure must never make live topology unavailable.
    }
  }
}

export async function assertRuntime(config = defaultConfig()) {
  await access(config.vtctldclientPath);
  if (config.startScript) await stat(config.startScript);
  return true;
}
