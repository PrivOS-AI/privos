import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run } from "../dist/lib.js";

const VM = {
  PRIVOS_SANDBOX_MODE: "true",
  PROXY_URL: "http://proxy.test",
  PROXY_TOKEN: "tok",
  PRIVOS_HUB_HOST: "hub.test",
  PRIVOS_ROOM_ID: "R1",
};

function recorder() {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), token: new Headers(init.headers).get("x-proxy-token"), envelope: JSON.parse(init.body) });
    return new Response('{"success":true,"n":1}', { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

async function cli(args, rec, env = VM) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { write: (c) => { stdout += c; } }, { write: (c) => { stderr += c; } }, { env, fetch: rec.fetch });
  return { code, stdout, stderr };
}

describe("hub api", () => {
  test("GET goes through the egress with the query and prints the answer", async () => {
    const rec = recorder();
    const r = await cli(
      ["hub", "api", "GET", "/api/v1/internal/rooms/R1/lists/byTemplateKey", "--query", "templateKey=crm", "--query", "x=a b"],
      rec,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].url, "http://proxy.test/egress");
    assert.equal(rec.calls[0].token, "tok");
    assert.equal(rec.calls[0].envelope.method, "GET");
    assert.equal(rec.calls[0].envelope.url, "https://hub.test/api/v1/internal/rooms/R1/lists/byTemplateKey?templateKey=crm&x=a+b");
    assert.deepEqual(JSON.parse(r.stdout), { success: true, n: 1 });
  });

  test("POST is a dry run without --confirm and sends the JSON body with it", async () => {
    const rec = recorder();
    const args = ["hub", "api", "post", "/api/v1/internal/rooms/R1/items/batch-move", "--body", '{"itemIds":["a"],"stageId":"s"}'];
    const dry = await cli(args, rec);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /"dryRun": true/);
    assert.equal(rec.calls.length, 0);
    const sent = await cli([...args, "--confirm"], rec);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(rec.calls[0].envelope.method, "POST");
    assert.equal(rec.calls[0].envelope.url, "https://hub.test/api/v1/internal/rooms/R1/items/batch-move");
    assert.deepEqual(JSON.parse(rec.calls[0].envelope.body), { itemIds: ["a"], stageId: "s" });
  });

  test("bad method, path, body and query are usage errors with no request", async () => {
    const rec = recorder();
    for (const args of [
      ["hub", "api", "PATCH", "/api/v1/x"],
      ["hub", "api", "GET", "/api/v2/x"],
      ["hub", "api", "GET", "/api/v1/../x"],
      ["hub", "api", "GET", "/api/v1/x?y=1"],
      ["hub", "api", "GET", "/api/v1/x#y"],
      ["hub", "api", "GET", "/api/v1//x"],
      ["hub", "api", "GET", "https://evil.test/api/v1/x"],
      ["hub", "api", "GET", "/api/v1/x", "extra"],
      ["hub", "api", "GET"],
      ["hub", "api", "GET", "/api/v1/x", "--body", "{}"],
      ["hub", "api", "POST", "/api/v1/x", "--body", "not json", "--confirm"],
      ["hub", "api", "GET", "/api/v1/x", "--query", "novalue"],
      ["hub", "api", "GET", "/api/v1/x", "--list", "L2"],
    ]) {
      const r = await cli(args, rec);
      assert.equal(r.code, 2, `${args.join(" ")} → ${r.code} ${r.stderr}`);
    }
    assert.equal(rec.calls.length, 0);
  });

  test("hub api --help prints its usage", async () => {
    const r = await cli(["hub", "api", "--help"], recorder());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /privos hub api METHOD/);
  });
});

describe("hub api {room}", () => {
  test("{room} in path, query and body is the agent room, or --room", async () => {
    const rec = recorder();
    const r = await cli(
      ["hub", "api", "POST", "/api/v1/internal/rooms/{room}/items/batch-move", "--query", "r={room}", "--body", '{"roomId":"{room}"}', "--confirm"],
      rec,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rec.calls[0].envelope.url, "https://hub.test/api/v1/internal/rooms/R1/items/batch-move?r=R1");
    assert.deepEqual(JSON.parse(rec.calls[0].envelope.body), { roomId: "R1" });
    const other = await cli(["hub", "api", "GET", "/api/v1/internal/rooms/{room}/stages", "--room", "R7"], rec);
    assert.equal(other.code, 0, other.stderr);
    assert.match(rec.calls[1].envelope.url, /\/rooms\/R7\/stages$/);
    const bad = await cli(["hub", "api", "GET", "/api/v1/internal/rooms/{room}/stages", "--room", "a/b"], rec);
    assert.equal(bad.code, 2);
    const none = await cli(["hub", "api", "GET", "/api/v1/internal/rooms/{room}/stages"], rec, { ...VM, PRIVOS_ROOM_ID: "" });
    assert.equal(none.code, 2);
    assert.equal(rec.calls.length, 2);
  });

  test("message commands default to the agent room over egress", async () => {
    const rec = recorder();
    const r = await cli(["hub", "messages", "send", "--text", "hi", "--confirm"], rec);
    assert.equal(r.code, 0, r.stderr);
    assert.match(rec.calls[0].envelope.url, /\/api\/v1\/chat\.sendMessage$/);
    assert.deepEqual(JSON.parse(rec.calls[0].envelope.body), { message: { rid: "R1", msg: "hi" } });
  });
});
