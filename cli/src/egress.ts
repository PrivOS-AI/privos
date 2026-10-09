import { normalizeBaseURL, type HubConfig } from "./config.js";
import type { Parsed } from "./parse.js";
import { usage } from "./usage.js";

/**
 * Inside an agent VM the bot key never exists: the sandbox proxy holds it and attaches it to the
 * requests its catalog allows. The CLI therefore sends each hub call to POST $PROXY_URL/egress as
 * { url, method, headers, body } and authenticates to the proxy with x-proxy-token only.
 */
export interface EgressConfig {
  proxyURL: string;
  token: string;
  hubHost: string;
}

const adapters = new WeakMap<object, EgressConfig>();

/** Hub commands that run as the agent bot. Everything else keeps its own credentials and transport. */
const EGRESS_COMMANDS = /^(hub (rooms|lists|items|dm)|agents a2a) \S/;

/** Headers the envelope may carry. Credentials are never forwarded: the proxy strips them and adds the key. */
const FORWARDED_HEADERS = ["accept", "content-type", "user-agent"];

/** Credential sources of PAT and bot-key mode. Any of them set means the caller chose its own transport. */
const OWN_CREDENTIAL_ENV = [
  "PRIVOS_BOT_KEY",
  "PRIVOS_HUB_USER_ID",
  "PRIVOS_USER_ID",
  "PRIVOS_HUB_AUTH_TOKEN",
  "PRIVOS_PAT",
];

function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

/** The VM contract: PRIVOS_SANDBOX_MODE=true with PROXY_URL and PROXY_TOKEN. Null anywhere else. */
export function egressConfig(): EgressConfig | null {
  if (env("PRIVOS_SANDBOX_MODE") !== "true") return null;
  const proxy = env("PROXY_URL");
  const token = env("PROXY_TOKEN");
  if (proxy === "" || token === "") return null;
  if (/[\r\n]/.test(token)) throw usage("PROXY_TOKEN contains a newline");
  let proxyURL: string;
  try {
    proxyURL = normalizeBaseURL(proxy);
  } catch (err) {
    throw usage(`PROXY_URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { proxyURL, token, hubHost: env("PRIVOS_HUB_HOST") };
}

function hasOwnCredentials(p: Parsed): boolean {
  return [p.botKey, p.userId, p.authToken, ...OWN_CREDENTIAL_ENV.map(env)].some((v) => v !== "");
}

/** The fetch a hub command should use: the egress adapter for bot commands in a VM without credentials of their own. */
export function transportFor(p: Parsed, cmd: string, base: typeof fetch): typeof fetch {
  if (!EGRESS_COMMANDS.test(cmd) || hasOwnCredentials(p)) return base;
  const cfg = egressConfig();
  return cfg === null ? base : egressFetch(cfg, base);
}

/** The adapter's config, or undefined for a plain fetch. This is how a command learns it runs as the bot over egress. */
export function egressOf(fetchImpl: typeof fetch): EgressConfig | undefined {
  return adapters.get(fetchImpl);
}

export function egressFetch(cfg: EgressConfig, base: typeof fetch): typeof fetch {
  const adapter = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = headers.get(name);
      if (value !== null) forwarded[name] = value;
    }
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new Error("egress carries string bodies only");
    }
    const envelope = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: forwarded,
      body: body ?? undefined,
    };
    try {
      return await base(`${cfg.proxyURL}/egress`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-proxy-token": cfg.token },
        body: JSON.stringify(envelope),
        redirect: "manual",
        signal: init?.signal,
      });
    } catch (err) {
      throw new Error(`sandbox proxy egress: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  adapters.set(adapter, cfg);
  return adapter as typeof fetch;
}

/** Hub base URL for egress calls: --url or PRIVOS_HUB_URL, else https://$PRIVOS_HUB_HOST. No credentials. */
export function resolveEgressHub(flagURL: string, cfg: EgressConfig): HubConfig {
  const raw = flagURL.trim() !== "" ? flagURL : env("PRIVOS_HUB_URL");
  let baseURL: string;
  if (raw.trim() !== "") {
    try {
      baseURL = normalizeBaseURL(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw usage(msg.startsWith("hub ") ? msg : `hub ${msg}`);
    }
  } else {
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(cfg.hubHost)) {
      throw usage("PRIVOS_HUB_HOST must name the hub (host or host:port) in an agent VM; or pass --url");
    }
    baseURL = `https://${cfg.hubHost}`;
  }
  return { baseURL, userId: "", authToken: "", botKey: "" };
}

/**
 * A command that cannot use egress (a direct hub or board connection, or a socket). In a VM it fails
 * with a clear message when it has no configuration of its own, instead of a misleading "token required".
 */
export function refuseEgress(cmd: string, needs: string, configured: () => unknown): void {
  if (egressConfig() === null) return;
  try {
    configured();
  } catch {
    throw usage(
      `${cmd} cannot go through the sandbox egress: ${needs}. ` +
        "Configure it explicitly, or run the command outside the agent VM.",
    );
  }
}
