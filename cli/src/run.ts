import { sandboxTasksAnswer } from "./answer.js";
import { VERSION } from "./config.js";
import { helpFor, rootHelp } from "./help.js";
import {
  hubA2aChain,
  hubA2aMembers,
  hubA2aSend,
  hubA2aStop,
  hubItemsCreate,
  hubItemsDelete,
  hubItemsFind,
  hubItemsGet,
  hubItemsList,
  hubItemsMove,
  hubItemsReorder,
  hubItemsSearch,
  hubItemsUpdate,
  hubListsCreate,
  hubListsDelete,
  hubListsGet,
  hubListsList,
  hubListsUpdate,
  hubMessagesDelete,
  hubMessagesList,
  hubMessagesSend,
  hubMessagesUpdate,
  hubRoomsCreate,
  hubRoomsDelete,
  hubRoomsList,
  hubRoomsUpdate,
} from "./hub.js";
import {
  commandOf,
  forbidUnknown,
  parseArgs,
  type Parsed,
} from "./parse.js";
import type { Out } from "./render.js";
import {
  sandboxModelsList,
  sandboxProjectsCreate,
  sandboxProjectsDelete,
  sandboxProjectsList,
  sandboxProjectsStart,
  sandboxProjectsUpdate,
  sandboxTasksAttempts,
  sandboxTasksConversation,
  sandboxTasksCreate,
  sandboxTasksDelete,
  sandboxTasksList,
  sandboxTasksQuestion,
  sandboxTasksRunning,
  sandboxTasksStart,
  sandboxTasksUpdate,
} from "./sandbox.js";
import { hubInbox, subscribe, subscribeStatus, type SubscribeDeps } from "./subscribe.js";
import { isUsage, usage } from "./usage.js";

export async function run(
  args: string[],
  stdout: Out,
  stderr: Out,
  deps?: Partial<SubscribeDeps>,
): Promise<number> {
  try {
    const parsed = parseArgs(args);
    await dispatch(parsed, stdout, stderr, { ...deps, fetch: deps?.fetch ?? globalThis.fetch });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
    return isUsage(err) ? 2 : 1;
  }
}

async function dispatch(p: Parsed, stdout: Out, stderr: Out, deps: SubscribeDeps): Promise<void> {
  const fetchImpl = deps.fetch;
  if (p.positionals.length === 0) {
    if (p.help) {
      stdout.write(rootHelp);
      return;
    }
    if (p.seen.has("version")) {
      forbidUnknown(p, "privos version", []);
      stdout.write(`privos ${VERSION}\n`);
      return;
    }
    throw usage("missing command\n\nRun privos --help");
  }
  if (p.positionals[0] === "help") {
    if (p.positionals.length !== 1) throw usage("privos help: unexpected arguments");
    stdout.write(rootHelp);
    return;
  }
  const text = helpFor(p.positionals);
  if (text === "") {
    throw usage(`unknown command ${JSON.stringify(commandOf(p))}\n\nRun privos --help`);
  }
  if (p.help) {
    stdout.write(text);
    return;
  }
  if (p.seen.has("version")) {
    throw usage('pass --version or "privos version" on its own');
  }

  const cmd = commandOf(p);
  switch (cmd) {
    case "version":
      forbidUnknown(p, "privos version", []);
      stdout.write(`privos ${VERSION}\n`);
      return;
    case "sandbox":
    case "sandbox projects":
    case "sandbox tasks":
    case "sandbox models":
    case "hub":
    case "hub rooms":
    case "hub messages":
    case "hub lists":
    case "hub items":
    case "agents":
    case "agents a2a":
      throw usage(`${text.trimEnd()}\nRun privos ${cmd} --help`);
    case "subscribe":
      await subscribe(p, stdout, stderr, deps);
      return;
    case "subscribe status":
      subscribeStatus(p, stdout);
      return;
    case "agents a2a send":
      await hubA2aSend(p, stdout, stderr, fetchImpl);
      return;
    case "agents a2a members":
      await hubA2aMembers(p, stdout, fetchImpl);
      return;
    case "agents a2a chain":
      await hubA2aChain(p, stdout, fetchImpl);
      return;
    case "agents a2a stop":
      await hubA2aStop(p, stdout, stderr, fetchImpl);
      return;
    case "hub inbox":
      await hubInbox(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox projects list":
      await sandboxProjectsList(p, stdout, fetchImpl);
      return;
    case "sandbox projects create":
      await sandboxProjectsCreate(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox projects update":
      await sandboxProjectsUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox projects delete":
      await sandboxProjectsDelete(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox projects start":
      await sandboxProjectsStart(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox tasks list":
      await sandboxTasksList(p, stdout, fetchImpl);
      return;
    case "sandbox tasks create":
      await sandboxTasksCreate(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox tasks update":
      await sandboxTasksUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox tasks delete":
      await sandboxTasksDelete(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox tasks start":
      await sandboxTasksStart(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox tasks attempts":
      await sandboxTasksAttempts(p, stdout, fetchImpl);
      return;
    case "sandbox tasks conversation":
      await sandboxTasksConversation(p, stdout, fetchImpl);
      return;
    case "sandbox tasks running":
      await sandboxTasksRunning(p, stdout, fetchImpl);
      return;
    case "sandbox tasks question":
      await sandboxTasksQuestion(p, stdout, fetchImpl);
      return;
    case "sandbox tasks answer":
      await sandboxTasksAnswer(p, stdout, stderr, fetchImpl);
      return;
    case "sandbox models list":
      await sandboxModelsList(p, stdout, fetchImpl);
      return;
    case "hub rooms list":
      await hubRoomsList(p, stdout, fetchImpl);
      return;
    case "hub rooms create":
      await hubRoomsCreate(p, stdout, stderr, fetchImpl);
      return;
    case "hub rooms update":
      await hubRoomsUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "hub rooms delete":
      await hubRoomsDelete(p, stdout, stderr, fetchImpl);
      return;
    case "hub messages list":
      await hubMessagesList(p, stdout, fetchImpl);
      return;
    case "hub messages send":
      await hubMessagesSend(p, stdout, stderr, fetchImpl);
      return;
    case "hub messages update":
      await hubMessagesUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "hub messages delete":
      await hubMessagesDelete(p, stdout, stderr, fetchImpl);
      return;
    case "hub lists list":
      await hubListsList(p, stdout, fetchImpl);
      return;
    case "hub lists get":
      await hubListsGet(p, stdout, fetchImpl);
      return;
    case "hub lists create":
      await hubListsCreate(p, stdout, stderr, fetchImpl);
      return;
    case "hub lists update":
      await hubListsUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "hub lists delete":
      await hubListsDelete(p, stdout, stderr, fetchImpl);
      return;
    case "hub items list":
      await hubItemsList(p, stdout, fetchImpl);
      return;
    case "hub items get":
      await hubItemsGet(p, stdout, fetchImpl);
      return;
    case "hub items search":
      await hubItemsSearch(p, stdout, fetchImpl);
      return;
    case "hub items find":
      await hubItemsFind(p, stdout, fetchImpl);
      return;
    case "hub items create":
      await hubItemsCreate(p, stdout, stderr, fetchImpl);
      return;
    case "hub items update":
      await hubItemsUpdate(p, stdout, stderr, fetchImpl);
      return;
    case "hub items delete":
      await hubItemsDelete(p, stdout, stderr, fetchImpl);
      return;
    case "hub items move":
      await hubItemsMove(p, stdout, stderr, fetchImpl);
      return;
    case "hub items reorder":
      await hubItemsReorder(p, stdout, stderr, fetchImpl);
      return;
    default:
      throw usage(`unknown command ${JSON.stringify(cmd)}\n\nRun privos --help`);
  }
}
