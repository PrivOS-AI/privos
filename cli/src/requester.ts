import type { Parsed } from "./parse.js";
import { usage } from "./usage.js";

/** Who is asking, as a claim the board records. The board decides how far to trust it. */
export interface Requester {
  kind: "human" | "agent";
  id: string;
  name?: string;
}

/** Flags every sandbox command accepts, so a forbidUnknown list can spread them. */
export const REQUESTER_FLAGS = ["requester", "requester-name", "requester-kind"];

const MAX_LEN = 64;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function field(label: string, value: string): string {
  const v = value.trim();
  if (v.length > MAX_LEN) throw usage(`${label} is longer than ${MAX_LEN} characters`);
  if (!PRINTABLE_ASCII.test(v)) throw usage(`${label} must be printable ASCII`);
  return v;
}

/**
 * Flags win over env (PRIVOS_REQUESTER_ID, PRIVOS_REQUESTER_NAME, PRIVOS_REQUESTER_KIND).
 * Returns null when no claim is made. A name or kind without an id is an error:
 * the board cannot attribute a claim that names nobody.
 */
export function resolveRequester(
  flags: Pick<Parsed, "requester" | "requesterName" | "requesterKind"> = { requester: "", requesterName: "", requesterKind: "" },
  env: NodeJS.ProcessEnv = process.env,
): Requester | null {
  const pick = (flag: string, key: string) => (flag.trim() !== "" ? flag : (env[key] ?? "")).trim();
  const id = pick(flags.requester, "PRIVOS_REQUESTER_ID");
  const name = pick(flags.requesterName, "PRIVOS_REQUESTER_NAME");
  const kind = pick(flags.requesterKind, "PRIVOS_REQUESTER_KIND");
  if (id === "") {
    if (name !== "" || kind !== "") {
      throw usage("--requester-name and --requester-kind need --requester ID (or PRIVOS_REQUESTER_ID)");
    }
    return null;
  }
  if (kind !== "" && kind !== "human" && kind !== "agent") {
    throw usage("--requester-kind must be human or agent");
  }
  return {
    kind: kind === "agent" ? "agent" : "human",
    id: field("requester id", id),
    ...(name !== "" ? { name: field("requester name", name) } : {}),
  };
}

/** The x-privos-requester-* headers; empty when there is no claim. */
export function requesterHeaders(r: Requester | null): Record<string, string> {
  if (r === null) return {};
  return {
    "x-privos-requester-id": r.id,
    ...(r.name !== undefined ? { "x-privos-requester-name": r.name } : {}),
    "x-privos-requester-kind": r.kind,
  };
}

/** The socket.io handshake `auth.requester` object. */
export function socketRequester(r: Requester): { kind: string; id: string; name?: string } {
  return { kind: r.kind, id: r.id, ...(r.name !== undefined ? { name: r.name } : {}) };
}

/** The socket.io handshake `auth` object: the key plus the claim when there is one. */
export function socketAuth(apiKey: string, r: Requester | null): Record<string, unknown> {
  return r === null ? { token: apiKey } : { token: apiKey, requester: socketRequester(r) };
}
