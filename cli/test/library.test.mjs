import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run, VERSION } from "../dist/lib.js";

const IDENTITY_KEYS = ["PRIVOS_SANDBOX_MODE", "PROXY_URL", "PROXY_TOKEN", "PRIVOS_HUB_HOST", "PRIVOS_ROOM_ID", "PRIVOS_BOT_ID", "HOME"];

function vmEnv(token, room) {
  return {
    PRIVOS_SANDBOX_MODE: "true",
    PROXY_URL: "http://proxy.test:8080",
    PROXY_TOKEN: token,
    PRIVOS_HUB_HOST: "hub.test",
    PRIVOS_ROOM_ID: room,
  };
}

/** A fetch that records each call, waits `delayMs`, and answers an empty list. */
function recordingFetch(delayMs = 0) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), envelope: JSON.parse(init.body) });
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    return new Response(JSON.stringify({ success: true, lists: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

async function call(args, deps) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { write: (c) => { stdout += c; } }, { write: (c) => { stderr += c; } }, deps);
  return { code, stdout, stderr };
}

describe("library use", { concurrency: false }, () => {
  test("the injected env drives egress while process.env is empty", async () => {
    const saved = Object.fromEntries(IDENTITY_KEYS.map((k) => [k, process.env[k]]));
    for (const k of IDENTITY_KEYS) delete process.env[k];
    try {
      const { impl, calls } = recordingFetch();
      const r = await call(["hub", "lists", "list"], { env: vmEnv("tok-a", "R1"), fetch: impl });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://proxy.test:8080/egress");
      assert.equal(calls[0].headers.get("x-proxy-token"), "tok-a");
      assert.equal(calls[0].envelope.url, "https://hub.test/api/v1/internal/rooms/R1/lists");
      assert.equal(calls[0].envelope.method, "GET");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  test("two concurrent runs never share identity", async () => {
    const a = recordingFetch(30);
    const b = recordingFetch(5);
    const [ra, rb] = await Promise.all([
      call(["hub", "lists", "list"], { env: vmEnv("t1", "R1"), fetch: a.impl }),
      call(["hub", "lists", "list"], { env: vmEnv("t2", "R2"), fetch: b.impl }),
    ]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
    assert.equal(a.calls[0].headers.get("x-proxy-token"), "t1");
    assert.match(a.calls[0].envelope.url, /\/rooms\/R1\/lists$/);
    assert.equal(b.calls[0].headers.get("x-proxy-token"), "t2");
    assert.match(b.calls[0].envelope.url, /\/rooms\/R2\/lists$/);
  });

  test("--file ~/x without HOME in the env is a usage error and sends nothing", async () => {
    const { impl, calls } = recordingFetch();
    const r = await call(["hub", "files", "upload", "--file", "~/x.txt", "--confirm"], {
      env: vmEnv("t1", "R1"),
      fetch: impl,
    });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /needs HOME/);
    assert.equal(calls.length, 0);
  });

  test("VERSION is exported", () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });
});
