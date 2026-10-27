import { HUB_AUTH, hubClient, roomOrEnv, sendHub } from "./hub.js";
import { helpFor } from "./help.js";
import { forbidUnknown, pathSegment, type Parsed } from "./parse.js";
import { render, type Out } from "./render.js";
import { usage } from "./usage.js";

const METHODS = ["GET", "POST", "PUT", "DELETE"];
const ROOM = "{room}";

/** /api/v1/ then word, dot and dash segments: no query, fragment, space, backslash, "." or ".." segment. */
function apiPath(raw: string): string {
  const bad =
    !raw.startsWith("/api/v1/") ||
    !/^[\w.\-/]+$/.test(raw) ||
    raw.slice(1).split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) {
    throw usage(
      'hub api: PATH must start with /api/v1/ and hold only letters, digits, ".", "_", "-" and "/" (no query, fragment, space or ".."); pass query values with --query key=value',
    );
  }
  return raw;
}

/**
 * `privos hub api METHOD /api/v1/... [--body JSON] [--query k=v]`: one raw hub call for routes that have no named
 * command. Reads print the answer as it came; writes are a dry run unless --confirm, like every other write.
 */
export async function hubApi(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub api", [...HUB_AUTH, "body", "query", "room"]);
  const [, , rawMethod = "", pathArg = "", ...extra] = p.positionals;
  if (rawMethod === "" || pathArg === "" || extra.length > 0) {
    throw usage(`hub api: expected METHOD and PATH\n\n${helpFor(["hub", "api"])}`);
  }
  // {room} in the path, a --query value or --body is the room: --room, else the agent VM's PRIVOS_ROOM_ID.
  let roomId: string | undefined;
  const withRoom = (text: string): string => {
    if (!text.includes(ROOM)) return text;
    roomId ??= pathSegment("room", roomOrEnv(p, "{room} needs"));
    return text.replaceAll(ROOM, roomId);
  };
  const rawPath = withRoom(pathArg);
  const method = rawMethod.toUpperCase();
  if (!METHODS.includes(method)) throw usage(`hub api: METHOD must be one of ${METHODS.join(", ")}`);
  const query = new URLSearchParams();
  for (const pair of p.queries) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw usage(`--query must be key=value, got ${JSON.stringify(pair)}`);
    query.append(pair.slice(0, eq), withRoom(pair.slice(eq + 1)));
  }
  const path = apiPath(rawPath);
  let body: unknown;
  if (p.body !== "") {
    if (method !== "POST" && method !== "PUT") throw usage("hub api: --body is for POST and PUT only");
    const text = withRoom(p.body);
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw usage("--body must be JSON");
    }
  }
  if (method === "GET") {
    if (p.format === "table") throw usage("hub api prints the route's JSON body; --format table is not supported");
    render(stdout, await hubClient(p, fetchImpl).get(path, query), "json", p.raw, "", []);
    return;
  }
  const target = query.size > 0 ? `${path}?${query.toString()}` : path;
  await sendHub(p, [{ method, path: target, body }], stdout, stderr, fetchImpl);
}
