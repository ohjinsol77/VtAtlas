import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("main topology page exposes a first-class DBA mode entry point", () => {
  assert.match(index, /href="\/admin\.html#dba"/);
  assert.match(index, />\s*DBA 모드\s*</);
});

test("admin UI separates viewer, DBA, scope, approval, results, and audit surfaces", () => {
  for (const id of [
    "dba-mode-button",
    "scope-cluster",
    "scope-keyspace",
    "scope-shard",
    "scope-tablet",
    "operation-grid",
    "dba-entry-dialog",
    "operation-dialog",
    "prepare-summary",
    "confirmation-field",
    "audit-section",
    "result-output",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /인증 연동 전 단계/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
});

test("admin client sends explicit intent headers and never calls a raw VTAdmin port", () => {
  assert.match(script, /X-VtAtlas-Admin-Intent/);
  assert.match(script, /X-VtAtlas-DBA-Intent/);
  assert.match(script, /\/api\/operator\/prepare/);
  assert.match(script, /\/api\/operator\/execute/);
  assert.match(script, /confirmationPhrase/);
  assert.doesNotMatch(script, /14200|14201|14202|17890/);
});
