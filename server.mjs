import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, TopologyCollector } from "./lib/collector.mjs";
import {
  normalizeManagedCluster,
  readRegistry,
  writeRegistry,
} from "./lib/server-registry.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(appDir, "public");
const vtadminClusterConfigFile = path.resolve(
  process.env.VTA_CLUSTER_CONFIG ?? path.join(appDir, "vtadmin", "clusters.json"),
);
const host = process.env.VTV_HOST ?? "127.0.0.1";
const port = Number(process.env.VTV_PORT ?? 17888);
const refreshIntervalMs = Math.max(
  5000,
  Number(process.env.VTV_REFRESH_INTERVAL_MS ?? 15000),
);
const appConfig = defaultConfig();
const collector = new TopologyCollector(appConfig);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

let latest = null;
let collecting = null;

async function refresh() {
  if (!collecting) {
    collecting = collector
      .collect()
      .then((result) => {
        latest = result;
        return result;
      })
      .finally(() => {
        collecting = null;
      });
  }
  return collecting;
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function securityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

async function requestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 128 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

function assertRegistryMutation(request) {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !==
      "application/json" ||
    request.headers["x-vitess-topology-intent"] !== "manage-servers"
  ) {
    const error = new Error("server management intent header is required");
    error.status = 400;
    throw error;
  }
  if (request.headers.origin) {
    const origin = new URL(request.headers.origin);
    if (!LOOPBACK_HOSTS.has(origin.hostname)) {
      const error = new Error("cross-origin server management is forbidden");
      error.status = 403;
      throw error;
    }
  }
}

async function builtInClusters() {
  const configFile = vtadminClusterConfigFile;
  const config = JSON.parse(await readFile(configFile, "utf8"));
  return Promise.all(
    (config.clusters ?? []).map(async (cluster) => {
      const discovery = JSON.parse(
        await readFile(
          path.resolve(path.dirname(configFile), cluster.discoveryFile),
          "utf8",
        ),
      );
      return {
        ...normalizeManagedCluster({ ...cluster, discovery }),
        builtIn: true,
      };
    }),
  );
}

async function serverRegistryResponse() {
  const [builtIn, registry] = await Promise.all([
    builtInClusters(),
    readRegistry(appConfig.managedClusterFile),
  ]);
  return {
    localhostOnly: true,
    remoteVitessReadOnly: true,
    reloadMode: "automatic",
    builtIn,
    managed: registry.clusters.map((cluster) => ({
      ...cluster,
      builtIn: false,
    })),
  };
}

async function mutateServerRegistry(request, pathname) {
  assertRegistryMutation(request);
  const builtInIds = new Set(
    (await builtInClusters()).map((cluster) => cluster.id),
  );
  const registry = await readRegistry(appConfig.managedClusterFile);
  const encodedId = pathname.startsWith("/api/servers/")
    ? pathname.slice("/api/servers/".length)
    : "";
  const id = encodedId ? decodeURIComponent(encodedId) : "";

  if (request.method === "POST" && pathname === "/api/servers") {
    const cluster = normalizeManagedCluster(await requestJson(request));
    if (
      builtInIds.has(cluster.id) ||
      registry.clusters.some((item) => item.id === cluster.id)
    ) {
      const error = new Error(`이미 등록된 Cluster ID입니다: ${cluster.id}`);
      error.status = 409;
      throw error;
    }
    registry.clusters.push(cluster);
    await writeRegistry(appConfig.managedClusterFile, registry);
    return { status: 201, body: { ok: true, cluster } };
  }

  const index = registry.clusters.findIndex((cluster) => cluster.id === id);
  if (index < 0) {
    const error = new Error(`관리 대상 Cluster를 찾을 수 없습니다: ${id}`);
    error.status = 404;
    throw error;
  }
  if (request.method === "PUT") {
    const cluster = normalizeManagedCluster(await requestJson(request));
    if (cluster.id !== id) {
      const error = new Error("Cluster ID는 수정할 수 없습니다.");
      error.status = 400;
      throw error;
    }
    registry.clusters[index] = cluster;
    await writeRegistry(appConfig.managedClusterFile, registry);
    return { status: 200, body: { ok: true, cluster } };
  }
  if (request.method === "DELETE") {
    registry.clusters.splice(index, 1);
    await writeRegistry(appConfig.managedClusterFile, registry);
    return { status: 200, body: { ok: true, removed: id } };
  }
  const error = new Error("method not allowed");
  error.status = 405;
  throw error;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) {
    json(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(resolved)] ?? "application/octet-stream",
      "Content-Length": fileStat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(resolved).pipe(response);
  } catch {
    json(response, 404, { error: "not found" });
  }
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
  try {
    if (url.pathname === "/api/health" && request.method === "GET") {
      json(response, 200, {
        status: "ok",
        readOnly: true,
        collecting: Boolean(collecting),
        collectedAt: latest?.collectedAt,
      });
      return;
    }
    if (url.pathname === "/api/topology" && request.method === "GET") {
      json(response, 200, latest ?? (await refresh()));
      return;
    }
    if (url.pathname === "/api/servers" && request.method === "GET") {
      json(response, 200, await serverRegistryResponse());
      return;
    }
    if (
      (url.pathname === "/api/servers" && request.method === "POST") ||
      (url.pathname.startsWith("/api/servers/") &&
        ["PUT", "DELETE"].includes(request.method ?? ""))
    ) {
      const result = await mutateServerRegistry(request, url.pathname);
      json(response, result.status, result.body);
      return;
    }
    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") {
        json(response, 405, { error: "method not allowed" });
        return;
      }
      json(response, 200, await refresh());
      return;
    }
    if (url.pathname.startsWith("/api/raw/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/raw/".length));
      const source = collector.rawSource(id);
      if (!source) {
        json(response, 404, { error: "source not found" });
        return;
      }
      json(response, 200, source);
      return;
    }
    if (url.pathname === "/api/configuration" && request.method === "GET") {
      json(response, 200, {
        topologyReadOnly: true,
        serverRegistryWritable: true,
        bind: host,
        refreshIntervalMs,
        vtctldAddress: latest?.environment?.vtctldAddress,
        startScript: latest?.environment?.startScript,
      });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    json(response, error.status ?? 500, { error: error.message });
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

await refresh();
const timer = setInterval(() => void refresh(), refreshIntervalMs);
timer.unref();

server.listen(port, host, () => {
  process.stdout.write(
    `Vitess Topology Viewer listening on http://${host}:${port} (read-only)\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    const shutdownTimer = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 2000);
    shutdownTimer.unref();
  });
}
