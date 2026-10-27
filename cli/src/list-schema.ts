import {
  botMode,
  botRoomBase,
  HUB_AUTH,
  HUB_READ,
  hubClient,
  hubGetPath,
  parseJSONObject,
  record,
  rejectTable,
  sendHub,
} from "./hub.js";
import { helpFor } from "./help.js";
import { type PlannedRequest } from "./mutate.js";
import {
  commandOf,
  forbidUnknown,
  optionalNonNegative,
  parseJSONArray,
  pathSegment,
  requireFlag,
  type Parsed,
} from "./parse.js";
import { render, type Column, type Out } from "./render.js";
import { usage } from "./usage.js";

/** Stages, field definitions and item custom-field values: the list schema work of the privos-list skill. */

const stageColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "NAME", path: ["name"] },
  { header: "ORDER", path: ["order"] },
  { header: "COLOR", path: ["color"] },
];

const fieldColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "NAME", path: ["name"] },
  { header: "TYPE", path: ["type"] },
  { header: "ORDER", path: ["order"] },
];

const FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DATE",
  "DATE_TIME",
  "SELECT",
  "MULTI_SELECT",
  "USER",
  "CHECKBOX",
  "URL",
  "FILE",
  "FILE_MULTIPLE",
  "DOCUMENT",
  "ASSIGNEE",
  "DEADLINE",
  "DEPENDENCIES",
  "RECURRING",
];

const OPTION_TYPES = ["SELECT", "MULTI_SELECT"];

function help(p: Parsed): string {
  return helpFor(p.positionals);
}

function color(value: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw usage("--color must be #RRGGBB");
  return value;
}

/** Field definitions and item values exist only as room routes; a personal token has no route for them. */
function requireBot(p: Parsed, fetchImpl: typeof fetch): void {
  if (!botMode(p, fetchImpl)) {
    throw usage(
      `${commandOf(p)}: bot mode only (a bot key, or the sandbox egress in an agent VM); ` +
        "the field routes are /api/v1/internal/rooms/ROOM_ID/...",
    );
  }
}

// ── Stages ─────────────────────────────────────────────────────

export async function hubStagesList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub stages list", [...HUB_READ, "list", ...(bot ? ["room"] : [])]);
  requireFlag(p, "list", p.list, help(p));
  const query = new URLSearchParams({ listId: p.list });
  const path = bot ? `${botRoomBase(p)}/stages` : "/api/v1/stages.listByListId";
  await hubGetPath(p, stdout, fetchImpl, path, query, "stages", stageColumns);
}

export async function hubStagesCreate(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub stages create", [...HUB_AUTH, "list", "name", "color", "order", ...(bot ? ["room"] : [])]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "name", p.name, help(p));
  const body: Record<string, unknown> = { listId: p.list, name: p.name };
  if (p.color !== "") body.color = color(p.color);
  const order = optionalNonNegative("--order", p.order);
  if (order !== undefined) body.order = order;
  const path = bot ? `${botRoomBase(p)}/stages` : "/api/v1/stages.create";
  await sendHub(p, [{ method: "POST", path, body }], stdout, stderr, fetchImpl);
}

export async function hubStagesUpdate(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub stages update", [...HUB_AUTH, "id", "name", "color", "order", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, help(p));
  const body: Record<string, unknown> = {};
  if (p.name !== "") body.name = p.name;
  if (p.color !== "") body.color = color(p.color);
  const order = optionalNonNegative("--order", p.order);
  if (order !== undefined) {
    if (!bot) throw usage("hub stages update: --order needs bot mode; with a personal token use stages.updateOrder");
    body.order = order;
  }
  if (Object.keys(body).length === 0) {
    throw usage(`hub stages update: pass at least one of --name, --color, --order\n\n${help(p)}`);
  }
  const plan: PlannedRequest = bot
    ? { method: "PUT", path: `${botRoomBase(p)}/stages/${pathSegment("id", p.id)}`, body }
    : { method: "POST", path: "/api/v1/stages.update", body: { stageId: p.id, ...body } };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

export async function hubStagesDelete(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub stages delete", [...HUB_AUTH, "id", "move-to", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, help(p));
  // The hub refuses to delete a stage that still has items unless they move to another stage.
  const move = p.moveTo !== "" ? { moveItemsToStageId: p.moveTo } : undefined;
  const plan: PlannedRequest = bot
    ? { method: "DELETE", path: `${botRoomBase(p)}/stages/${pathSegment("id", p.id)}`, body: move }
    : { method: "POST", path: "/api/v1/stages.delete", body: { stageId: p.id, ...move } };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

// ── Field definitions ─────────────────────────────────────────

function fieldsBase(p: Parsed): string {
  return `${botRoomBase(p)}/lists/${pathSegment("list", p.list)}/fields`;
}

function fieldType(value: string): string {
  const type = value.toUpperCase();
  if (!FIELD_TYPES.includes(type)) throw usage(`--type must be one of ${FIELD_TYPES.join(", ")}`);
  return type;
}

/** SELECT and MULTI_SELECT values are option ids, so every option needs its own `_id` and a `value`. */
function fieldOptions(value: string, type: string): unknown[] {
  if (!OPTION_TYPES.includes(type)) throw usage("--options applies to SELECT and MULTI_SELECT fields");
  const options = parseJSONArray("options", value);
  for (const entry of options) {
    const { _id, value: label } = record(entry);
    if (typeof _id !== "string" || !/^[\w.-]+$/.test(_id) || typeof label !== "string" || label.trim() === "") {
      throw usage('--options: every option needs a string "_id" (letters, digits, ".", "_", "-") and a "value", e.g. [{"_id":"opt_high","value":"High"}]');
    }
  }
  return options;
}

export async function hubFieldsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub fields list", [...HUB_READ, "list", "room"]);
  requireFlag(p, "list", p.list, help(p));
  await hubGetPath(p, stdout, fetchImpl, fieldsBase(p), undefined, "fieldDefinitions", fieldColumns);
}

export async function hubFieldsGet(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub fields get", [...HUB_READ, "list", "field", "room"]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "field", p.field, help(p));
  rejectTable(p, "hub fields get");
  await hubGetPath(p, stdout, fetchImpl, `${fieldsBase(p)}/${pathSegment("field", p.field)}`, undefined, "", []);
}

export async function hubFieldsAdd(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub fields add", [...HUB_AUTH, "list", "name", "type", "options", "display-format", "order", "room"]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "name", p.name, help(p));
  requireFlag(p, "type", p.fieldType, help(p));
  const type = fieldType(p.fieldType);
  const field: Record<string, unknown> = { name: p.name, type };
  if (p.options !== "") field.options = fieldOptions(p.options, type);
  else if (OPTION_TYPES.includes(type)) throw usage(`hub fields add: a ${type} field needs --options\n\n${help(p)}`);
  if (p.displayFormat !== "") field.displayFormat = parseJSONObject("display-format", p.displayFormat);
  const order = optionalNonNegative("--order", p.order);
  if (order !== undefined) field.order = order;
  await sendHub(p, [{ method: "POST", path: fieldsBase(p), body: { field } }], stdout, stderr, fetchImpl);
}

export async function hubFieldsUpdate(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub fields update", [...HUB_AUTH, "list", "field", "name", "type", "options", "display-format", "order", "room"]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "field", p.field, help(p));
  if (![p.name, p.fieldType, p.options, p.displayFormat, p.order].some((v) => v !== "")) {
    throw usage(`hub fields update: pass at least one of --name, --type, --options, --display-format, --order\n\n${help(p)}`);
  }
  const path = `${fieldsBase(p)}/${pathSegment("field", p.field)}`;
  // The route overwrites name and type with whatever it gets, so start from the current definition.
  const current = record(record(JSON.parse((await hubClient(p, fetchImpl).get(path)).toString("utf8"))).field);
  if (typeof current.name !== "string") throw new Error(`GET ${path}: the answer carries no field`);
  const type = p.fieldType !== "" ? fieldType(p.fieldType) : String(current.type);
  const data: Record<string, unknown> = { name: p.name !== "" ? p.name : current.name, type };
  if (p.options !== "") data.options = fieldOptions(p.options, type);
  if (p.displayFormat !== "") data.displayFormat = parseJSONObject("display-format", p.displayFormat);
  const order = optionalNonNegative("--order", p.order);
  if (order !== undefined) data.order = order;
  await sendHub(p, [{ method: "PUT", path, body: { data } }], stdout, stderr, fetchImpl);
}

export async function hubFieldsDelete(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub fields delete", [...HUB_AUTH, "list", "field", "room"]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "field", p.field, help(p));
  const path = `${fieldsBase(p)}/${pathSegment("field", p.field)}`;
  await sendHub(p, [{ method: "DELETE", path }], stdout, stderr, fetchImpl);
}

/** add | update | delete one option of a SELECT or MULTI_SELECT field. --name is the option's label (its `value`). */
export async function hubFieldOptions(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
  action: "add" | "update" | "delete",
): Promise<void> {
  requireBot(p, fetchImpl);
  const cmd = `hub fields options ${action}`;
  forbidUnknown(p, cmd, [...HUB_AUTH, "list", "field", "room", ...(action === "add" ? [] : ["option"]), ...(action === "delete" ? [] : ["name", "color", "order"])]);
  requireFlag(p, "list", p.list, help(p));
  requireFlag(p, "field", p.field, help(p));
  if (action !== "add") requireFlag(p, "option", p.option, help(p));
  if (action === "add") requireFlag(p, "name", p.name, help(p));
  const body: Record<string, unknown> = {};
  if (p.name !== "") body.value = p.name;
  if (p.color !== "") body.color = color(p.color);
  const order = optionalNonNegative("--order", p.order);
  if (order !== undefined) body.order = order;
  if (action === "update" && Object.keys(body).length === 0) {
    throw usage(`${cmd}: pass at least one of --name, --color, --order\n\n${help(p)}`);
  }
  const base = `${fieldsBase(p)}/${pathSegment("field", p.field)}/options`;
  const plan: PlannedRequest =
    action === "add"
      ? { method: "POST", path: base, body }
      : action === "update"
        ? { method: "PUT", path: `${base}/${pathSegment("option", p.option)}`, body }
        : { method: "DELETE", path: `${base}/${pathSegment("option", p.option)}` };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

// ── Item custom-field values ──────────────────────────────────

function itemFieldsBase(p: Parsed): string {
  return `${botRoomBase(p)}/items/${pathSegment("id", p.id)}/customFields`;
}

/** --value is JSON (string, number, boolean, array, object, null); text that is not JSON is taken as a string. */
function fieldValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function hubItemsFieldsGet(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub items fields get", [...HUB_READ, "id", "room"]);
  requireFlag(p, "id", p.id, help(p));
  rejectTable(p, "hub items fields get");
  const body = await hubClient(p, fetchImpl).get(itemFieldsBase(p));
  render(stdout, body, p.format, p.raw, "", []);
}

export async function hubItemsFieldsSet(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub items fields set", [...HUB_AUTH, "id", "field", "value", "custom-fields", "room"]);
  requireFlag(p, "id", p.id, help(p));
  const one = p.field !== "" || p.fieldValue !== "";
  if (one === (p.customFields !== "")) {
    throw usage(`hub items fields set: pass --field with --value, or --custom-fields, not both\n\n${help(p)}`);
  }
  let plan: PlannedRequest;
  if (one) {
    requireFlag(p, "field", p.field, help(p));
    requireFlag(p, "value", p.fieldValue, help(p));
    plan = { method: "PUT", path: `${itemFieldsBase(p)}/${pathSegment("field", p.field)}`, body: { value: fieldValue(p.fieldValue) } };
  } else {
    const fields = parseJSONArray("custom-fields", p.customFields);
    if (fields.some((f) => typeof record(f).fieldId !== "string")) {
      throw usage('--custom-fields must be a JSON array of {"fieldId","value"} objects');
    }
    plan = { method: "PUT", path: itemFieldsBase(p), body: { fields } };
  }
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

export async function hubItemsFieldsClear(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  requireBot(p, fetchImpl);
  forbidUnknown(p, "hub items fields clear", [...HUB_AUTH, "id", "field", "room"]);
  requireFlag(p, "id", p.id, help(p));
  requireFlag(p, "field", p.field, help(p));
  const path = `${itemFieldsBase(p)}/${pathSegment("field", p.field)}`;
  await sendHub(p, [{ method: "DELETE", path }], stdout, stderr, fetchImpl);
}
