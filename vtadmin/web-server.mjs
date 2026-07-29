import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const host = process.env.VTA_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.VTA_WEB_PORT ?? 14201);
const apiAddress = process.env.VTA_API_ADDRESS ?? "http://localhost:14200";
const buildDir =
  process.env.VTA_WEB_BUILD ?? "/opt/vitess/current/web/vtadmin/build";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

if (!LOOPBACK_HOSTS.has(host)) {
  throw new Error(`VTAdmin Web must bind to localhost, got ${host}`);
}
const apiUrl = new URL(apiAddress);
if (!LOOPBACK_HOSTS.has(apiUrl.hostname)) {
  throw new Error(`VTAdmin API address must use localhost, got ${apiUrl.hostname}`);
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function securityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ${apiUrl.origin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendRuntimeConfig(response, headOnly) {
  const payload = `window.env = ${JSON.stringify(
    {
      VITE_VTADMIN_API_ADDRESS: apiUrl.origin,
      VITE_FETCH_CREDENTIALS: "omit",
      VITE_ENABLE_EXPERIMENTAL_TABLET_DEBUG_VARS: true,
      VITE_BUGSNAG_API_KEY: "",
      VITE_DOCUMENT_TITLE: "VTAdmin · Local Read Only",
      VITE_READONLY_MODE: true,
    },
    null,
    2,
  )};\n`;
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(headOnly ? undefined : payload);
}

async function sendFile(response, filePath, headOnly) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("not a file");
  response.writeHead(200, {
    "Content-Type":
      mimeTypes[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=3600",
  });
  if (headOnly) response.end();
  else createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? host}`,
  );
  if (requestUrl.pathname === "/config/config.js") {
    sendRuntimeConfig(response, request.method === "HEAD");
    return;
  }

  const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
  const candidate = path.resolve(buildDir, relative || "index.html");
  if (
    candidate !== path.resolve(buildDir) &&
    !candidate.startsWith(`${path.resolve(buildDir)}${path.sep}`)
  ) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    await sendFile(response, candidate, request.method === "HEAD");
  } catch {
    try {
      await sendFile(
        response,
        path.join(buildDir, "index.html"),
        request.method === "HEAD",
      );
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("VTAdmin Web build not found");
    }
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `VTAdmin Web listening on http://${host}:${port} (read-only UI)\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    const shutdownTimer = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 2000);
    shutdownTimer.unref();
  });
}
