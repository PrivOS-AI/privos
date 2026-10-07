import { usage } from "./usage.js";

/** Printed by `privos version`. */
export const VERSION = "0.6.0";

export interface SandboxConfig {
  baseURL: string;
  apiKey: string;
}

export interface HubConfig {
  baseURL: string;
  userId: string;
  authToken: string;
  /** An agent bot key. When set the CLI sends Authorization: Bearer and no X-User-Id/X-Auth-Token. */
  botKey: string;
}

function getenv(key: string): string {
  return (process.env[key] ?? "").trim();
}

function first(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== "") return value.trim();
  }
  return "";
}

/** Absolute http(s) URL with no userinfo, query, or fragment. */
export function normalizeBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw usage("base URL is empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw usage(`base URL ${JSON.stringify(trimmed)} must be an absolute http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usage(`base URL ${JSON.stringify(trimmed)} must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw usage(
      "base URL must not include userinfo; pass credentials with flags or environment variables",
    );
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function rejectNewlines(label: string, value: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw usage(`${label} contains a newline`);
  }
}

/**
 * URL: --url, then PRIVOS_SANDBOX_URL.
 * Key: --api-key, then PRIVOS_SANDBOX_API_KEY, API_ACCESS_KEY, SANDBOX_API_KEY.
 */
export function resolveSandbox(flagURL: string, flagKey: string): SandboxConfig {
  const rawURL = first(flagURL, getenv("PRIVOS_SANDBOX_URL"));
  if (rawURL === "") {
    throw usage(
      "sandbox base URL is required.\nSet --url or PRIVOS_SANDBOX_URL.\nA default self-hosted board listens on http://127.0.0.1:8556",
    );
  }
  let base: string;
  try {
    base = normalizeBaseURL(rawURL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usage(msg.startsWith("sandbox ") ? msg : `sandbox ${msg}`);
  }
  const key = first(
    flagKey,
    getenv("PRIVOS_SANDBOX_API_KEY"),
    getenv("API_ACCESS_KEY"),
    getenv("SANDBOX_API_KEY"),
  );
  if (key === "") {
    throw usage(
      "sandbox API key is required.\nSet --api-key or one of PRIVOS_SANDBOX_API_KEY, API_ACCESS_KEY, SANDBOX_API_KEY.\nThe board reads this value from the x-api-key header (container env API_ACCESS_KEY).",
    );
  }
  rejectNewlines("sandbox API key", key);
  return { baseURL: base, apiKey: key };
}

/**
 * URL: --url, then PRIVOS_HUB_URL, then PRIVOS_ROOT_URL.
 * User: --user-id, then PRIVOS_HUB_USER_ID, then PRIVOS_USER_ID.
 * Token: --auth-token, then PRIVOS_HUB_AUTH_TOKEN, then PRIVOS_PAT.
 * Bot key (only for callers that pass flagBotKey): --bot-key, then PRIVOS_BOT_KEY. When set it
 * replaces the user id and token, because agent bots cannot mint personal access tokens.
 */
export function resolveHub(
  flagURL: string,
  flagUser: string,
  flagToken: string,
  flagBotKey?: string,
): HubConfig {
  const rawURL = first(flagURL, getenv("PRIVOS_HUB_URL"), getenv("PRIVOS_ROOT_URL"));
  if (rawURL === "") {
    throw usage(
      "hub base URL is required.\nSet --url, PRIVOS_HUB_URL, or PRIVOS_ROOT_URL.\nA default self-hosted hub listens on http://127.0.0.1:3000",
    );
  }
  let base: string;
  try {
    base = normalizeBaseURL(rawURL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usage(msg.startsWith("hub ") ? msg : `hub ${msg}`);
  }
  const botKey = flagBotKey === undefined ? "" : first(flagBotKey, getenv("PRIVOS_BOT_KEY"));
  if (botKey !== "") {
    if (flagBotKey !== "" && (flagUser !== "" || flagToken !== "")) {
      throw usage("--bot-key cannot be combined with --user-id or --auth-token");
    }
    rejectNewlines("hub bot key", botKey);
    return { baseURL: base, userId: "", authToken: "", botKey };
  }
  const user = first(flagUser, getenv("PRIVOS_HUB_USER_ID"), getenv("PRIVOS_USER_ID"));
  if (user === "") {
    throw usage(
      "hub user id is required.\nSet --user-id, PRIVOS_HUB_USER_ID, or PRIVOS_USER_ID.\nSend it as the X-User-Id header.",
    );
  }
  const token = first(flagToken, getenv("PRIVOS_HUB_AUTH_TOKEN"), getenv("PRIVOS_PAT"));
  if (token === "") {
    throw usage(
      "hub auth token is required.\nSet --auth-token, PRIVOS_HUB_AUTH_TOKEN, or PRIVOS_PAT.\nSend it as the X-Auth-Token header.",
    );
  }
  rejectNewlines("hub user id", user);
  rejectNewlines("hub auth token", token);
  return { baseURL: base, userId: user, authToken: token, botKey: "" };
}
