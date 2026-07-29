import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  loopbackBaseUrl,
  redactValue,
  vtadminRequest,
} from "../lib/vtadmin-client.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("loopback origin validation rejects credentials, paths, and remote hosts", () => {
  assert.equal(loopbackBaseUrl("http://127.0.0.1:14200"), "http://127.0.0.1:14200");
  assert.equal(loopbackBaseUrl("http://[::1]:14200"), "http://[::1]:14200");
  assert.throws(() => loopbackBaseUrl("http://example.com:14200"), /loopback/);
  assert.throws(() => loopbackBaseUrl("http://localhost:14200/api"), /origin/);
  assert.throws(() => loopbackBaseUrl("http://user:pw@localhost:14200"), /origin/);
  assert.throws(() => loopbackBaseUrl("file:///tmp/api"), /HTTP/);
});

test("VTAdmin client parses envelopes and redacts secret-bearing response fields", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          token: "do-not-leak",
          nested: { password: "also-secret", value: "safe" },
        },
      }),
    );
  });
  const base = await listen(server);
  try {
    const result = await vtadminRequest(base, {
      method: "GET",
      path: "/api/clusters",
    });
    assert.equal(result.ok, true);
    assert.equal(result.body.result.token, "<redacted>");
    assert.equal(result.body.result.nested.password, "<redacted>");
    assert.equal(result.body.result.nested.value, "safe");
  } finally {
    await close(server);
  }
});

test("VTAdmin client rejects paths outside /api and enforces response limits", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: "x".repeat(4096) }));
  });
  const base = await listen(server);
  try {
    await assert.rejects(
      vtadminRequest(base, { method: "GET", path: "/debug/vars" }),
      /allowlist/,
    );
    await assert.rejects(
      vtadminRequest(
        base,
        { method: "GET", path: "/api/clusters" },
        { maxResponseBytes: 512 },
      ),
      /size limit/,
    );
  } finally {
    await close(server);
  }
});

test("VTAdmin client applies a request timeout", async () => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    }, 150);
  });
  const base = await listen(server);
  try {
    await assert.rejects(
      vtadminRequest(
        base,
        { method: "GET", path: "/api/clusters" },
        { timeoutMs: 20 },
      ),
      /timed out/,
    );
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("redaction also sanitizes secrets embedded in diagnostic strings", () => {
  const value = redactValue({
    message: "connection failed password=hunter2 authorization: Bearer abc",
  });
  assert.doesNotMatch(value.message, /hunter2|Bearer abc/);
  assert.match(value.message, /<redacted>/);
});
