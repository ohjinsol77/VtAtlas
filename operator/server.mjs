import { appendFile, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { authenticateOperator } from "./auth.mjs";
import {
  buildOperationRequest,
  confirmationPhrase,
  DBA_OPERATIONS,
  getOperation,
  publicOperation,
} from "../lib/vtadmin-operations.mjs";
import {
  loopbackBaseUrl,
  redactValue,
  vtadminRequest,
} from "../lib/vtadmin-client.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

const host = process.env.VTO_HOST ?? "127.0.0.1";
if (!LOOPBACK_BIND_HOSTS.has(host)) {
  throw new Error("VTO_HOST must be a loopback host");
}
const port = boundedInteger(process.env.VTO_PORT ?? 17890, 1, 65535, "VTO_PORT");
const vtadminApi = loopbackBaseUrl(
  process.env.VTO_VTADMIN_API ?? "http://127.0.0.1:14202",
  "operator VTAdmin API",
);
const auditFile =
  process.env.VTO_AUDIT_FILE ??
  path.join(projectDir, "var", "operator-audit.jsonl");
const sessionTtlMs = boundedInteger(
  process.env.VTO_SESSION_TTL_MS ?? 15 * 60_000,
  60_000,
  60 * 60_000,
  "VTO_SESSION_TTL_MS",
);
const approvalTtlMs = boundedInteger(
  process.env.VTO_APPROVAL_TTL_MS ?? 2 * 60_000,
  30_000,
  10 * 60_000,
  "VTO_APPROVAL_TTL_MS",
);
const SESSION_COOKIE = "vtatlas_dba_session";
const sessions = new Map();
const approvals = new Map();

function isLoopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function securityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) {
      const error = new Error("operator request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("operator request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return index < 0
          ? [decodeURIComponent(item), ""]
          : [
              decodeURIComponent(item.slice(0, index)),
              decodeURIComponent(item.slice(index + 1)),
            ];
      }),
  );
}

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  for (const [id, approval] of approvals) {
    if (approval.expiresAt <= now) approvals.delete(id);
  }
}

async function activeSession(request) {
  prune();
  const id = cookies(request)[SESSION_COOKIE];
  const session = id ? sessions.get(id) : null;
  if (!session) {
    const error = new Error("DBA mode session is not active");
    error.status = 401;
    throw error;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  session.actor = await authenticateOperator(request);
  return session;
}

function assertIntent(request, expected) {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !==
      "application/json" ||
    request.headers["x-vtatlas-dba-intent"] !== expected
  ) {
    const error = new Error(`DBA intent header ${expected} is required`);
    error.status = 400;
    throw error;
  }
}

async function audit(event) {
  await mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
  await appendFile(
    auditFile,
    `${JSON.stringify(redactValue({ at: new Date().toISOString(), ...event }))}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function envelopeResult(result, key) {
  const body = result?.body;
  if (!result?.ok || !body?.ok) {
    const error = new Error(body?.error ?? body?.message ?? `VTAdmin ${key} failed`);
    error.status = result?.status >= 400 ? 502 : 503;
    throw error;
  }
  return body.result ?? {};
}

async function inventory() {
  const [clustersResult, keyspacesResult, tabletsResult] = await Promise.all([
    vtadminRequest(vtadminApi, { method: "GET", path: "/api/clusters" }),
    vtadminRequest(vtadminApi, { method: "GET", path: "/api/keyspaces" }),
    vtadminRequest(vtadminApi, { method: "GET", path: "/api/tablets" }),
  ]);
  return {
    clusters: envelopeResult(clustersResult, "clusters").clusters ?? [],
    keyspaces: envelopeResult(keyspacesResult, "keyspaces").keyspaces ?? [],
    tablets: envelopeResult(tabletsResult, "tablets").tablets ?? [],
  };
}

function keyspaceName(item) {
  return item?.keyspace?.name ?? item?.name ?? "";
}

function tabletAlias(item) {
  const alias = item?.tablet?.alias;
  if (typeof alias === "string") return alias;
  if (!alias?.cell || !Number.isFinite(Number(alias.uid))) return "";
  return `${alias.cell}-${String(alias.uid).padStart(10, "0")}`;
}

function targetError(message, status = 404) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function preflight(item, payload) {
  const data = await inventory();
  const fields = payload.fields ?? {};
  const cluster = data.clusters.find((entry) => entry.id === fields.cluster);
  if (!cluster) {
    throw targetError(`Cluster를 찾을 수 없습니다: ${fields.cluster}`);
  }

  const clusterKeyspaces = data.keyspaces.filter(
    (entry) => entry?.cluster?.id === fields.cluster,
  );
  if (item.id === "create_keyspace") {
    const existing = clusterKeyspaces.some(
      (entry) => keyspaceName(entry) === fields.newKeyspace,
    );
    if (existing && !payload.body?.force) {
      throw targetError(
        `이미 존재하는 Keyspace입니다: ${fields.newKeyspace}`,
        409,
      );
    }
  }
  const keyspace = fields.keyspace
    ? clusterKeyspaces.find((entry) => keyspaceName(entry) === fields.keyspace)
    : null;
  if (
    fields.keyspace &&
    !["create_keyspace"].includes(item.id) &&
    !(item.id === "create_shard" && payload.body?.include_parent) &&
    !keyspace
  ) {
    throw targetError(`Keyspace를 찾을 수 없습니다: ${fields.keyspace}`);
  }
  if (fields.shard && keyspace) {
    const exists = Object.hasOwn(keyspace.shards ?? {}, fields.shard);
    if (item.id === "create_shard" && exists && !payload.body?.force) {
      throw targetError(
        `이미 존재하는 Shard입니다: ${fields.keyspace}/${fields.shard}`,
        409,
      );
    }
    if (item.id !== "create_shard" && !exists) {
      throw targetError(
        `Shard를 찾을 수 없습니다: ${fields.keyspace}/${fields.shard}`,
      );
    }
  }
  if (fields.tablet) {
    const found = data.tablets.some(
      (entry) =>
        entry?.cluster?.id === fields.cluster &&
        tabletAlias(entry) === fields.tablet,
    );
    if (!found) {
      throw targetError(`Tablet을 찾을 수 없습니다: ${fields.tablet}`);
    }
  }
  return {
    cluster: { id: cluster.id, name: cluster.name },
    keyspace: fields.keyspace || fields.newKeyspace || undefined,
    shard: fields.shard || undefined,
    tablet: fields.tablet || undefined,
    inventory: {
      keyspaces: clusterKeyspaces.length,
      tablets: data.tablets.filter((entry) => entry?.cluster?.id === fields.cluster)
        .length,
    },
  };
}

async function readAudit() {
  try {
    const lines = (await readFile(auditFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-250);
    return lines.map((line) => JSON.parse(line)).reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function createOperatorServer() {
  return http.createServer(async (request, response) => {
    securityHeaders(response);
    if (!isLoopback(request.socket.remoteAddress)) {
      json(response, 403, { ok: false, error: "operator API is loopback only" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        json(response, 200, {
          ok: true,
          role: "operator",
          authenticationImplemented: false,
          vtadminApi,
        });
        return;
      }
      if (url.pathname === "/catalog" && request.method === "GET") {
        json(response, 200, {
          ok: true,
          authenticationImplemented: false,
          operations: DBA_OPERATIONS.map(publicOperation),
        });
        return;
      }
      if (url.pathname === "/session" && request.method === "GET") {
        try {
          const session = await activeSession(request);
          json(response, 200, {
            ok: true,
            active: true,
            expiresAt: new Date(session.expiresAt).toISOString(),
            actor: session.actor,
          });
        } catch {
          json(response, 200, {
            ok: true,
            active: false,
            authenticationImplemented: false,
          });
        }
        return;
      }
      if (url.pathname === "/session" && request.method === "POST") {
        assertIntent(request, "enable-dba-mode");
        const body = await requestJson(request);
        if (body.acknowledgement !== "DBA MODE") {
          const error = new Error("DBA MODE acknowledgement is required");
          error.status = 400;
          throw error;
        }
        const actor = await authenticateOperator(request);
        const id = randomUUID();
        const session = {
          id,
          actor,
          createdAt: Date.now(),
          expiresAt: Date.now() + sessionTtlMs,
        };
        sessions.set(id, session);
        await audit({ type: "session_enabled", actor });
        json(
          response,
          201,
          {
            ok: true,
            active: true,
            expiresAt: new Date(session.expiresAt).toISOString(),
            authenticationImplemented: false,
          },
          {
            "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/api/operator; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
          },
        );
        return;
      }
      if (url.pathname === "/session" && request.method === "DELETE") {
        assertIntent(request, "disable-dba-mode");
        const id = cookies(request)[SESSION_COOKIE];
        if (id) sessions.delete(id);
        await audit({ type: "session_disabled" });
        json(
          response,
          200,
          { ok: true, active: false },
          {
            "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/operator; Max-Age=0`,
          },
        );
        return;
      }
      if (url.pathname === "/audit" && request.method === "GET") {
        const session = await activeSession(request);
        json(response, 200, { ok: true, actor: session.actor, entries: await readAudit() });
        return;
      }
      if (url.pathname === "/prepare" && request.method === "POST") {
        assertIntent(request, "prepare-operation");
        const session = await activeSession(request);
        const body = await requestJson(request);
        const item = getOperation(body.actionId, "dba");
        const requestSpec = buildOperationRequest(item, body);
        const target = await preflight(item, body);
        const phrase = confirmationPhrase(item, body);
        const token = randomUUID();
        const approval = {
          token,
          item,
          payload: {
            fields: structuredClone(body.fields ?? {}),
            query: structuredClone(body.query ?? {}),
            body: structuredClone(body.body ?? item.defaultBody ?? {}),
          },
          requestSpec,
          target,
          phrase,
          actor: session.actor,
          createdAt: Date.now(),
          expiresAt: Date.now() + approvalTtlMs,
        };
        approvals.set(token, approval);
        await audit({
          type: "operation_prepared",
          actionId: item.id,
          severity: item.severity,
          target,
          actor: session.actor,
        });
        json(response, 201, {
          ok: true,
          approvalToken: token,
          expiresAt: new Date(approval.expiresAt).toISOString(),
          confirmationPhrase: phrase,
          operation: publicOperation(item),
          target,
          upstream: { method: requestSpec.method, path: requestSpec.path },
        });
        return;
      }
      if (url.pathname === "/execute" && request.method === "POST") {
        assertIntent(request, "execute-operation");
        const session = await activeSession(request);
        const body = await requestJson(request);
        prune();
        const approval = approvals.get(String(body.approvalToken ?? ""));
        if (!approval) {
          const error = new Error("approval token is missing, expired, or already used");
          error.status = 409;
          throw error;
        }
        approvals.delete(approval.token);
        if (body.confirmation !== approval.phrase) {
          const error = new Error("confirmation phrase does not match");
          error.status = 400;
          throw error;
        }
        const auditId = randomUUID();
        await audit({
          type: "operation_started",
          auditId,
          actionId: approval.item.id,
          severity: approval.item.severity,
          target: approval.target,
          upstream: {
            method: approval.requestSpec.method,
            path: approval.requestSpec.path,
          },
          actor: session.actor,
        });
        const started = performance.now();
        try {
          const result = await vtadminRequest(vtadminApi, approval.requestSpec, {
            timeoutMs: ["high", "critical"].includes(approval.item.severity)
              ? 120_000
              : 45_000,
          });
          const durationMs = Math.round(performance.now() - started);
          await audit({
            type: "operation_finished",
            auditId,
            actionId: approval.item.id,
            success: result.ok,
            status: result.status,
            durationMs,
            actor: session.actor,
          });
          json(response, result.ok ? 200 : 502, {
            ok: result.ok,
            auditId,
            durationMs,
            upstreamStatus: result.status,
            result: result.body,
          });
        } catch (error) {
          await audit({
            type: "operation_finished",
            auditId,
            actionId: approval.item.id,
            success: false,
            error: error.message,
            durationMs: Math.round(performance.now() - started),
            actor: session.actor,
          });
          throw error;
        }
        return;
      }
      json(response, 404, { ok: false, error: "operator endpoint not found" });
    } catch (error) {
      await audit({
        type: "operator_error",
        path: url.pathname,
        error: error.message,
      }).catch(() => {});
      json(response, error.status ?? 500, {
        ok: false,
        error: error.message,
      });
    }
  });
}

export function startOperatorServer() {
  const server = createOperatorServer();
  server.listen(port, host, () => {
    process.stdout.write(
      `VtAtlas Operator API listening on http://${host}:${port} (authentication deferred)\n`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections?.();
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        process.exit(0);
      }, 2000);
      timer.unref();
    });
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startOperatorServer();
}
