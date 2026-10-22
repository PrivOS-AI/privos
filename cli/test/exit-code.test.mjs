import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The entry point comes from the package's bin field, so the test runs the shipped program.
const pkgURL = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgURL, "utf8"));
const entry = new URL(pkg.bin.privos, pkgURL).pathname;

function privos(...args) {
  const env = { ...process.env };
  for (const key of ["PRIVOS_SANDBOX_URL", "PRIVOS_SANDBOX_API_KEY", "API_ACCESS_KEY", "SANDBOX_API_KEY"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

test("a failed command exits 1 with the reason on stderr only", () => {
  const r = privos(
    "sandbox", "tasks", "answer",
    "--url", "http://127.0.0.1:9", "--api-key", "k", "--id", "t1", "--answer", "x", "--confirm",
  );
  assert.equal(r.status, 1, r.stderr);
  assert.notEqual(r.stderr, "");
  assert.equal(r.stdout, "");
});

test("a usage error exits 2", () => {
  const r = privos("sandbox", "tasks", "answer");
  assert.equal(r.status, 2, r.stderr);
  assert.notEqual(r.stderr, "");
});
