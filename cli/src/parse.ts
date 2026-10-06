import { usage } from "./usage.js";

export interface Parsed {
  help: boolean;
  version: boolean;
  raw: boolean;
  confirm: boolean;
  dryRun: boolean;
  readOnly: boolean;
  excludeSelf: boolean;
  sandbox: boolean;
  autoStart: boolean;
  hookTemplate: boolean;
  format: string;
  timeout: string;
  url: string;
  apiKey: string;
  userId: string;
  authToken: string;
  projects: string[];
  members: string[];
  status: string;
  limit: string;
  after: string;
  room: string;
  kind: string;
  count: string;
  offset: string;
  id: string;
  list: string;
  updatedSince: string;
  name: string;
  path: string;
  title: string;
  description: string;
  text: string;
  topic: string;
  chatInit: string;
  autopilot: string;
  position: string;
  stage: string;
  parent: string;
  term: string;
  field: string;
  fieldValue: string;
  fieldDefinitions: string;
  customFields: string;
  crossTeam: string;
  isolated: string;
  archived: string;
  order: string;
  sort: string;
  showArchivedSubItems: string;
  model: string;
  provider: string;
  llmProvider: string;
  effort: string;
  prompt: string;
  before: string;
  includeSubItems: boolean;
  force: boolean;
  positionals: string[];
  seen: Set<string>;
}

const BOOL_FLAGS = new Set([
  "help",
  "version",
  "raw",
  "confirm",
  "dry-run",
  "read-only",
  "exclude-self",
  "sandbox",
  "auto-start",
  "hook-template",
  "include-sub-items",
  "force",
]);

const VALUE_FLAGS = new Set([
  "format",
  "timeout",
  "url",
  "api-key",
  "user-id",
  "auth-token",
  "project",
  "status",
  "limit",
  "after",
  "room",
  "kind",
  "count",
  "offset",
  "id",
  "list",
  "updated-since",
  "name",
  "path",
  "title",
  "description",
  "text",
  "topic",
  "member",
  "chat-init",
  "autopilot",
  "position",
  "stage",
  "parent",
  "term",
  "field",
  "value",
  "field-definitions",
  "custom-fields",
  "cross-team",
  "isolated",
  "archived",
  "order",
  "sort",
  "show-archived-sub-items",
  "model",
  "provider",
  "llm-provider",
  "effort",
  "prompt",
  "before",
]);

const REPEATABLE = new Set(["project", "member"]);

export function commandOf(p: Parsed): string {
  return p.positionals.join(" ");
}

export function forbidUnknown(p: Parsed, cmd: string, allowed: string[]): void {
  const ok = new Set(["format", "raw", "timeout", "help", ...allowed]);
  const bad: string[] = [];
  for (const name of p.seen) {
    if (!ok.has(name)) bad.push(`--${name}`);
  }
  if (bad.length === 0) return;
  bad.sort();
  throw usage(`${cmd}: unsupported flag ${bad.join(", ")}`);
}

export function timeoutSeconds(p: Parsed): number {
  if (p.timeout.trim() === "") return 30;
  const n = Number(p.timeout.trim());
  if (!Number.isInteger(n) || n < 1 || n > 300) {
    throw usage("--timeout must be a whole number of seconds from 1 to 300");
  }
  return n;
}

export function optionalNonNegative(flagName: string, value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 0) {
    throw usage(`${flagName} must be a non-negative integer`);
  }
  return n;
}

/** channel, group, or direct. Empty means channel. */
export function normalizeKind(kind: string): "channel" | "group" | "direct" {
  switch (kind.trim().toLowerCase()) {
    case "":
    case "channel":
    case "c":
      return "channel";
    case "group":
    case "private":
    case "p":
      return "group";
    case "direct":
    case "im":
    case "dm":
    case "d":
      return "direct";
    default:
      throw usage("--kind must be channel, group, or direct (aliases c, p, d)");
  }
}

export function messagePath(kind: string): string {
  switch (kind) {
    case "group":
      return "/api/v1/groups.messages";
    case "direct":
      return "/api/v1/im.messages";
    default:
      return "/api/v1/channels.messages";
  }
}

/** Room writes that exist for channels and private groups, not direct messages. */
export function roomWriteKind(kind: string): "channel" | "group" {
  const normalized = normalizeKind(kind);
  if (normalized === "direct") {
    throw usage("--kind direct is not a write target; use channel or group");
  }
  return normalized;
}

function looksLikeFlag(s: string): boolean {
  if (s === "-" || !s.startsWith("-")) return false;
  if (s.length > 1 && s[1]! >= "0" && s[1]! <= "9") return false;
  return true;
}

function emptyParsed(): Parsed {
  return {
    help: false,
    version: false,
    raw: false,
    confirm: false,
    dryRun: false,
    readOnly: false,
    excludeSelf: false,
    sandbox: false,
    autoStart: false,
    hookTemplate: false,
    format: "",
    timeout: "",
    url: "",
    apiKey: "",
    userId: "",
    authToken: "",
    projects: [],
    members: [],
    status: "",
    limit: "",
    after: "",
    room: "",
    kind: "",
    count: "",
    offset: "",
    id: "",
    list: "",
    updatedSince: "",
    name: "",
    path: "",
    title: "",
    description: "",
    text: "",
    topic: "",
    chatInit: "",
    autopilot: "",
    position: "",
    stage: "",
    parent: "",
    term: "",
    field: "",
    fieldValue: "",
    fieldDefinitions: "",
    customFields: "",
    crossTeam: "",
    isolated: "",
    archived: "",
    order: "",
    sort: "",
    showArchivedSubItems: "",
    model: "",
    provider: "",
    llmProvider: "",
    effort: "",
    prompt: "",
    before: "",
    includeSubItems: false,
    force: false,
    positionals: [],
    seen: new Set(),
  };
}

export function parseArgs(args: string[]): Parsed {
  const p = emptyParsed();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      p.positionals.push(...args.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-")) {
      p.positionals.push(a);
      continue;
    }
    let name = a;
    let value = "";
    let hasValue = false;
    if (a.startsWith("--")) {
      name = a.slice(2);
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
        hasValue = true;
      }
    } else if (a === "-h") {
      name = "help";
    } else {
      throw usage(`unknown flag ${a}`);
    }
    if (name === "") throw usage("missing flag name");
    if (BOOL_FLAGS.has(name)) {
      if (hasValue) throw usage(`--${name} does not take a value`);
      if (p.seen.has(name)) throw usage(`--${name} repeated`);
      p.seen.add(name);
      assignBool(p, name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw usage(`unknown flag --${name}`);
    if (!hasValue) {
      if (i + 1 >= args.length || looksLikeFlag(args[i + 1]!)) {
        throw usage(`--${name} requires a value`);
      }
      i++;
      value = args[i]!;
    }
    assignValue(p, name, value);
  }
  if (p.format !== "" && p.format !== "json" && p.format !== "table") {
    throw usage("--format must be json or table");
  }
  return p;
}

function assignBool(p: Parsed, name: string): void {
  switch (name) {
    case "help":
      p.help = true;
      break;
    case "version":
      p.version = true;
      break;
    case "raw":
      p.raw = true;
      break;
    case "confirm":
      p.confirm = true;
      break;
    case "dry-run":
      p.dryRun = true;
      break;
    case "read-only":
      p.readOnly = true;
      break;
    case "exclude-self":
      p.excludeSelf = true;
      break;
    case "sandbox":
      p.sandbox = true;
      break;
    case "auto-start":
      p.autoStart = true;
      break;
    case "hook-template":
      p.hookTemplate = true;
      break;
    case "include-sub-items":
      p.includeSubItems = true;
      break;
    case "force":
      p.force = true;
      break;
    default:
      throw usage(`unknown flag --${name}`);
  }
}

function assignValue(p: Parsed, name: string, value: string): void {
  if (!REPEATABLE.has(name) && p.seen.has(name)) throw usage(`--${name} repeated`);
  p.seen.add(name);
  const trimmed = value.trim();
  if (trimmed === "") throw usage(`--${name} requires a value`);
  switch (name) {
    case "format":
      p.format = trimmed;
      break;
    case "timeout":
      p.timeout = trimmed;
      break;
    case "url":
      p.url = trimmed;
      break;
    case "api-key":
      p.apiKey = trimmed;
      break;
    case "user-id":
      p.userId = trimmed;
      break;
    case "auth-token":
      p.authToken = trimmed;
      break;
    case "project":
      p.projects.push(trimmed);
      break;
    case "status":
      p.status = trimmed;
      break;
    case "limit":
      p.limit = trimmed;
      break;
    case "after":
      p.after = trimmed;
      break;
    case "room":
      p.room = trimmed;
      break;
    case "kind":
      p.kind = trimmed;
      break;
    case "count":
      p.count = trimmed;
      break;
    case "offset":
      p.offset = trimmed;
      break;
    case "id":
      p.id = trimmed;
      break;
    case "list":
      p.list = trimmed;
      break;
    case "updated-since":
      p.updatedSince = trimmed;
      break;
    case "name":
      p.name = trimmed;
      break;
    case "path":
      p.path = trimmed;
      break;
    case "title":
      p.title = trimmed;
      break;
    case "description":
      p.description = trimmed;
      break;
    case "text":
      p.text = trimmed;
      break;
    case "topic":
      p.topic = trimmed;
      break;
    case "member":
      p.members.push(trimmed);
      break;
    case "chat-init":
      p.chatInit = trimmed;
      break;
    case "autopilot":
      p.autopilot = trimmed;
      break;
    case "position":
      p.position = trimmed;
      break;
    case "stage":
      p.stage = trimmed;
      break;
    case "parent":
      p.parent = trimmed;
      break;
    case "term":
      p.term = trimmed;
      break;
    case "field":
      p.field = trimmed;
      break;
    case "value":
      p.fieldValue = trimmed;
      break;
    case "field-definitions":
      p.fieldDefinitions = trimmed;
      break;
    case "custom-fields":
      p.customFields = trimmed;
      break;
    case "cross-team":
      p.crossTeam = trimmed;
      break;
    case "isolated":
      p.isolated = trimmed;
      break;
    case "archived":
      p.archived = trimmed;
      break;
    case "order":
      p.order = trimmed;
      break;
    case "sort":
      p.sort = trimmed;
      break;
    case "show-archived-sub-items":
      p.showArchivedSubItems = trimmed;
      break;
    case "model":
      p.model = trimmed;
      break;
    case "provider":
      p.provider = trimmed;
      break;
    case "llm-provider":
      p.llmProvider = trimmed;
      break;
    case "effort":
      p.effort = trimmed;
      break;
    case "prompt":
      p.prompt = trimmed;
      break;
    case "before":
      p.before = trimmed;
      break;
    default:
      throw usage(`unknown flag --${name}`);
  }
}

export function requireFlag(p: Parsed, flagName: string, value: string, help: string): void {
  if (value.trim() === "") {
    throw usage(`${commandOf(p)}: required flag --${flagName}\n\n${help}`);
  }
}

/** One URL path segment. Rejects slashes so an id cannot retarget the request. */
export function pathSegment(flagName: string, value: string): string {
  if (!/^[\w.-]+$/.test(value)) {
    throw usage(
      `--${flagName} must be one path segment (letters, digits, ".", "_", "-")`,
    );
  }
  return encodeURIComponent(value);
}

export function parseBoolWord(flagName: string, value: string): boolean {
  switch (value.toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw usage(`--${flagName} must be true or false`);
  }
}

export function parseAutopilot(value: string): "off" | "autonomous" {
  switch (value.toLowerCase()) {
    case "off":
    case "autonomous":
      return value.toLowerCase() as "off" | "autonomous";
    default:
      throw usage("--autopilot must be off or autonomous");
  }
}

export function parseJSONArray(flagName: string, value: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw usage(`--${flagName} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) throw usage(`--${flagName} must be a JSON array`);
  return parsed;
}

export function parsePosition(value: string): number {
  if (!/^-?\d+$/.test(value)) throw usage("--position must be an integer");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw usage("--position must be an integer");
  return n;
}

/** Matches the board setup dialog: absolute POSIX path or a Windows drive path. */
export function requireAbsolutePath(value: string): string {
  if (value.startsWith("/") || /^[A-Za-z]:\\/.test(value)) return value;
  throw usage("--path must be an absolute path");
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const PROVIDERS = ["claude-cli", "claude-sdk", "privos-agent-sdk", "codex-cli", "antigravity-cli"] as const;

/** The effort values the board's attempt route accepts. */
export function parseEffort(value: string): string {
  if ((EFFORTS as readonly string[]).includes(value)) return value;
  throw usage(`--effort must be one of ${EFFORTS.join(", ")}`);
}

/** The runtime providers the board can launch. */
export function parseProvider(value: string): string {
  if ((PROVIDERS as readonly string[]).includes(value)) return value;
  throw usage(`--provider must be one of ${PROVIDERS.join(", ")}`);
}

export function mutationMode(p: Parsed): "dry" | "send" {
  if (p.confirm && p.dryRun) {
    throw usage("pass only one of --confirm and --dry-run");
  }
  return p.confirm ? "send" : "dry";
}
