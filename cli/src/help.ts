const rootHelp = `PrivOS operator CLI

Usage:
  privos [--format json|table] <command> [flags]
  privos version
  privos --help

Commands:
  sandbox projects list
  sandbox projects create
  sandbox projects update
  sandbox projects delete
  sandbox projects start
  sandbox tasks list
  sandbox tasks create
  sandbox tasks update
  sandbox tasks delete
  sandbox tasks start
  sandbox tasks attempts
  sandbox tasks conversation
  sandbox tasks running
  sandbox tasks question
  sandbox tasks answer
  sandbox models list
  hub rooms list
  hub rooms create
  hub rooms update
  hub rooms delete
  hub messages list
  hub messages send
  hub messages update
  hub messages delete
  hub lists list
  hub lists get
  hub lists create
  hub lists update
  hub lists delete
  hub items list
  hub items get
  hub items search
  hub items find
  hub items create
  hub items update
  hub items delete
  hub items move
  hub items reorder
  version                  Print the CLI version

Reads send GET. Writes are a dry run unless you pass --confirm: they print
the method, URL, and JSON body, and they do not send the request. --dry-run
is the same default and cannot be combined with --confirm.

privos does not install PrivOS. install.sh, compose.yml, and the signed
release bundle are unchanged.

Configuration, auth, and endpoint notes:
  docs/cli/README.md
  docs/api/sandbox.md
  docs/api/hub.md
`;

const sandboxHelp = `Usage:
  privos sandbox [--url URL] [--api-key KEY] <command>

Commands:
  projects list|create|update|delete|start
  tasks list|create|update|delete|start|attempts|conversation|running|question|answer
  models list

Environment (flags override):
  PRIVOS_SANDBOX_URL          Board base URL
  PRIVOS_SANDBOX_API_KEY      API key (preferred)
  API_ACCESS_KEY              Same key; the name the board process uses
  SANDBOX_API_KEY             Same key; the name install.sh writes

The key is sent as the x-api-key header. A default self-hosted board
listens on http://127.0.0.1:8556.

Writes (create, update, delete, start) print the request and send nothing
unless --confirm is set.

Global flags:
  --format json|table         Default json. Table is for list reads.
  --raw                       Print the response body unchanged
  --timeout SECONDS           HTTP timeout, 1-300 (default 30)
  --confirm                   Send a write. Without it, the write is a dry run.
  --dry-run                   Explicit dry run (the default for writes)
`;

const sandboxProjectsHelp = `Usage:
  privos sandbox projects <command>

Commands:
  list
  create --name NAME (--path ABS_PATH | --sandbox)
  update --id ID [--name NAME] [--autopilot off|autonomous]
  delete --id ID
  start --id ID

Writes require --confirm. The default is a dry run.
`;

const sandboxProjectsListHelp = `Usage:
  privos sandbox projects list [--url URL] [--api-key KEY]

List projects from GET /api/projects.

Environment: PRIVOS_SANDBOX_URL, PRIVOS_SANDBOX_API_KEY
(also API_ACCESS_KEY, SANDBOX_API_KEY).
`;

const sandboxProjectsCreateHelp = `Usage:
  privos sandbox projects create --name NAME --path ABS_PATH [--hook-template]
  privos sandbox projects create --sandbox --name NAME [--auto-start] [--hook-template]

POST /api/projects with {"name","path","useHookTemplate"} when --path is set.
That is the body the board setup dialog sends when client sandbox mode is off.

POST /api/sandbox/projects with {"projectName","autoStart","useHookTemplate"}
when --sandbox is set. That is the body the same dialog sends when client
sandbox mode is on (self-hosted sets PRIVOS_SANDBOX_MODE=true). --auto-start
sets autoStart true. It does not call the separate start route; use
"projects start" for POST /api/sandbox/projects/{id}/start.

--path must be absolute. Do not pass --path together with --sandbox.
Dry run unless --confirm.
`;

const sandboxProjectsUpdateHelp = `Usage:
  privos sandbox projects update --id ID [--name NAME] [--autopilot off|autonomous]

PATCH /api/projects/{id}. The board settings page sends {"name"} or
{"autopilotMode":"off"|"autonomous"}. At least one of --name or --autopilot
is required. Dry run unless --confirm.
`;

const sandboxProjectsDeleteHelp = `Usage:
  privos sandbox projects delete --id ID

DELETE /api/projects/{id}. Dry run unless --confirm.
`;

const sandboxProjectsStartHelp = `Usage:
  privos sandbox projects start --id ID

POST /api/sandbox/projects/{id}/start with no body. The board UI calls this
after creating a project in client sandbox mode. Dry run unless --confirm.
`;

const sandboxTasksHelp = `Usage:
  privos sandbox tasks <command>

Commands:
  list
  create --project ID --title TITLE [--description TEXT] [--status STATUS]
         [--start [--model M] [--provider P | --llm-provider ID] [--effort E]]
  update --id ID [--title T] [--description TEXT] [--status STATUS] [--position N] [--chat-init true|false]
  delete --id ID
  start --id ID [--model M] [--provider P | --llm-provider ID] [--effort E] [--prompt TEXT]
  attempts --id ID
  conversation --id ID [--limit N] [--before MS]
  running --id ID
  question --id ID
  answer --id ID --answer TEXT [--answer TEXT ...]

Writes require --confirm. The default is a dry run.
`;

const sandboxTasksListHelp = `Usage:
  privos sandbox tasks list [flags]

List tasks from GET /api/tasks.

Flags:
  --project ID        Limit to one project. Repeat to pass several.
                      Sent as the projectIds query parameter.
  --status STATUS     Filter by status (todo, in_progress, in_review,
                      done, cancelled, or any value the board accepts)
  --limit N           Page size (limit query parameter)
  --after CURSOR      Opaque cursor (position,updatedAt,id)
  --url URL           Board base URL
  --api-key KEY       x-api-key value

Environment: PRIVOS_SANDBOX_URL, PRIVOS_SANDBOX_API_KEY
(also API_ACCESS_KEY, SANDBOX_API_KEY).
`;

const sandboxTasksCreateHelp = `Usage:
  privos sandbox tasks create --project ID --title TITLE [--description TEXT] [--status STATUS]
         [--start [--model M] [--provider P | --llm-provider ID] [--effort E]]

POST /api/tasks with a JSON body and the x-project-id header set to --project.
The board client sends projectId, title, and optionally description and status.
status is omitted unless --status is set. Known board statuses: todo,
in_progress, in_review, done, cancelled. Dry run unless --confirm.

--start also starts an agent on the new task, in three requests:
  1. POST /api/tasks with "status":"in_progress"
  2. PATCH /api/tasks/{new id} {"chatInit":true}
  3. POST /api/attempts {"taskId","prompt","projectId",...} with x-project-id
--description is required and becomes the agent prompt. The new id is only
known after request 1, so the dry run shows {taskId from response 1} where
it will go. --model, --provider, --llm-provider and --effort work as in
"privos sandbox tasks start" and need --start.
`;

const sandboxTasksUpdateHelp = `Usage:
  privos sandbox tasks update --id ID [flags]

Title, description, and chat init use PATCH /api/tasks/{id}. The board client
sends {"title"}, {"description"}, or {"chatInit":true|false}.

Status uses PUT /api/tasks/reorder with {"taskId","status","position"}. That
is how the board moves a card. When --position is omitted, position is
-Date.now(), which is what the board client sends on a status change.

Pass any combination. A title change and a status change are two requests,
PATCH then PUT. Dry run unless --confirm.
`;

const sandboxTasksDeleteHelp = `Usage:
  privos sandbox tasks delete --id ID

DELETE /api/tasks/{id}. Dry run unless --confirm.
`;

const sandboxTasksStartHelp = `Usage:
  privos sandbox tasks start --id ID [--model M] [--provider P | --llm-provider ID]
                             [--effort E] [--prompt TEXT] [--force]

Start an agent on a task the way the board UI does. The CLI first reads
GET /api/tasks/{id} and GET /api/tasks/{id}/attempts, then sends, in order:
  1. PUT /api/tasks/reorder {"taskId","status":"in_progress","position"}
     only when the task is not already in_progress
  2. PATCH /api/tasks/{id} {"chatInit":true} only when chatInit is not true
  3. POST /api/attempts {"taskId","prompt","projectId",...} with the
     x-project-id header

The prompt defaults to the task description. --prompt replaces it.

The two GETs are sent even in a dry run, so the preview holds the real
projectId and prompt. No write is sent without --confirm.

start refuses while an attempt created in the last 24 hours is still
running. --force starts anyway; two agents then work on the same task at
the same time.

Flags:
  --model M            Model id, for example claude-opus-5-5
  --provider P         claude-cli, claude-sdk, privos-agent-sdk, codex-cli,
                       antigravity-cli
  --llm-provider ID    Custom catalog provider id (needs --model). Use the
                       LLM_PROVIDER value from "privos sandbox models list".
  --effort E           low, medium, high, xhigh, max, ultra. ultra is honoured
                       only by Claude runtimes. Effort is not stored on the
                       attempt, so reads show "effort": null.
  --prompt TEXT        Prompt for the agent (default: the task description)
  --force              Start even while a recent attempt is running

A task with no previous run should get --model and --provider; otherwise
the board picks its default. Dry run unless --confirm.
`;

const sandboxTasksAttemptsHelp = `Usage:
  privos sandbox tasks attempts --id ID

List a task's attempts from GET /api/tasks/{id}/attempts. This read has no
side effects. --format table shows ID, STATUS, MODEL, PROVIDER and CREATED.
Effort is not stored on attempts, so JSON shows "effort": null.
`;

const sandboxTasksConversationHelp = `Usage:
  privos sandbox tasks conversation --id ID [--limit N] [--before MS]

Read one page of a task's conversation from GET /api/tasks/{id}/conversation.
--limit sets the page size. --before takes a timestamp in milliseconds and
returns older messages. JSON only.
`;

const sandboxTasksRunningHelp = `Usage:
  privos sandbox tasks running --id ID

Read the running attempt, its messages and background shells from
GET /api/tasks/{id}/running-attempt. "attempt" is null when nothing runs.
JSON only.

Warning: the board also cleans up when you call this. It fails running attempts older than 24 hours and moves an in_progress task with no running attempt to in_review. Use "tasks attempts" for a read with no side effects.
`;

const sandboxTasksQuestionHelp = `Usage:
  privos sandbox tasks question --id ID

Read the agent's pending question from GET /api/tasks/{id}/pending-question.
"question" is null when the agent is not waiting. The questions print in
order; each needs one --answer, in the same order. JSON only.

Answer them with: privos sandbox tasks answer --id ID --answer TEXT ...
`;

const sandboxTasksAnswerHelp = `Usage:
  privos sandbox tasks answer --id ID --answer TEXT [--answer TEXT ...]

Answer the agent's pending question. Pass --answer once per question, in
the order "privos sandbox tasks question" prints them.

The CLI reads GET /api/tasks/{id} and GET /api/tasks/{id}/pending-question,
then sends the socket.io event question:answer
{"attemptId","projectId","toolUseId","questions","answers"} to the board,
with the API key as the handshake auth token. "answers" maps each question
text to its --answer. This is what the board UI sends.

The dry run reads the question and prints the payload; it opens no socket.
With --confirm the answer counts as delivered when the board acks it, or,
when no ack comes (sandbox mode), once a re-read shows the question gone.
The board acks a repeat of the same answer within 30 seconds without
applying it again.

After that the CLI also sends POST /api/attempts/{attemptId}/answer to save
the answer log. This is best effort: the board accepts it only for hub
attempts that carry a workspaceId, and any error is printed and ignored.
Dry run unless --confirm.
`;

const sandboxModelsHelp = `Usage:
  privos sandbox models <command>

Commands:
  list
`;

const sandboxModelsListHelp = `Usage:
  privos sandbox models list

List the board's model catalog from GET /api/models. --format table shows
ID, NAME, RUNTIME, LLM_PROVIDER and EFFORTS.

Pass the RUNTIME value to --provider and the ID to --model on "tasks start".
Rows with an LLM_PROVIDER are custom catalog models: start them with
--llm-provider <that id> --model <ID> instead of --provider. EFFORTS is
empty for many built-in rows; the board UI derives those levels itself.
`;

const hubHelp = `Usage:
  privos hub [--url URL] [--user-id ID] [--auth-token TOKEN] <command>

Commands:
  rooms list|create|update|delete
  messages list|send|update|delete
  lists list|get|create|update|delete
  items list|get|search|find|create|update|delete|move|reorder

Environment (flags override):
  PRIVOS_HUB_URL          Hub base URL
  PRIVOS_ROOT_URL         Used when PRIVOS_HUB_URL is unset (installer)
  PRIVOS_HUB_USER_ID      X-User-Id
  PRIVOS_HUB_AUTH_TOKEN   X-Auth-Token

A default self-hosted hub listens on http://127.0.0.1:3000
(PRIVOS_HUB_PORT). Create a personal access token in the hub UI, or
POST /api/v1/login, and pass that user id and token. The CLI does not
log in and does not read passwords.

Writes print the request and send nothing unless --confirm is set.
Global flags: --format json|table, --raw, --timeout SECONDS, --confirm, --dry-run.
`;

const hubRoomsHelp = `Usage:
  privos hub rooms <command>

Commands:
  list [--updated-since RFC3339]
  create --name NAME [--kind channel|group] [--member USER] [--read-only] [--exclude-self]
  update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]
  delete --room ID [--kind channel|group]

Writes require --confirm. Direct messages (--kind direct) are not a write target.
`;

const hubRoomsListHelp = `Usage:
  privos hub rooms list [--updated-since RFC3339] [--url URL]
                        [--user-id ID] [--auth-token TOKEN]

GET /api/v1/rooms.get. The table view prints the "update" array
(rooms for this user). The "t" field is the room type:
  c  channel (public)   use: privos hub messages list --kind channel
  p  private group      use: privos hub messages list --kind group
  d  direct message     use: privos hub messages list --kind direct

Environment: PRIVOS_HUB_URL or PRIVOS_ROOT_URL, PRIVOS_HUB_USER_ID,
PRIVOS_HUB_AUTH_TOKEN.
`;

const hubRoomsCreateHelp = `Usage:
  privos hub rooms create --name NAME [--kind channel|group]

POST /api/v1/channels.create (kind channel, the default) or
POST /api/v1/groups.create (kind group). Body fields follow Rocket.Chat:
name (required), members from repeated --member, readOnly when --read-only,
excludeSelf when --exclude-self. Omitted booleans keep the server default.
Dry run unless --confirm.
`;

const hubRoomsUpdateHelp = `Usage:
  privos hub rooms update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]

--name calls POST /api/v1/channels.rename or groups.rename with {roomId,name}.
--topic calls POST /api/v1/channels.setTopic or groups.setTopic with {roomId,topic}.
Both flags send both requests, rename then topic. At least one is required.
--kind defaults to channel. Dry run unless --confirm.
`;

const hubRoomsDeleteHelp = `Usage:
  privos hub rooms delete --room ID [--kind channel|group]

POST /api/v1/channels.delete or groups.delete with {"roomId"}.
--kind defaults to channel. Dry run unless --confirm.
There is no direct-message delete command in this CLI.
`;

const hubMessagesHelp = `Usage:
  privos hub messages <command>

Commands:
  list --room ROOM_ID [--kind channel|group|direct]
  send --room ROOM_ID --text TEXT
  update --room ROOM_ID --id MSG_ID --text TEXT
  delete --room ROOM_ID --id MSG_ID

Writes require --confirm.
`;

const hubMessagesListHelp = `Usage:
  privos hub messages list --room ROOM_ID [--kind channel|group|direct]

GET one of:
  channel (c)   /api/v1/channels.messages
  group (p)     /api/v1/groups.messages
  direct (d)    /api/v1/im.messages

--kind defaults to channel. Aliases: c, p, d, private, im, dm.

Flags:
  --room ROOM_ID     Required
  --kind KIND        Room type, default channel
  --count N          Page size (omitted unless set)
  --offset N         Skip this many messages (omitted unless set)
  --url URL
  --user-id ID
  --auth-token TOKEN

Environment: PRIVOS_HUB_URL or PRIVOS_ROOT_URL, PRIVOS_HUB_USER_ID,
PRIVOS_HUB_AUTH_TOKEN.
`;

const hubMessagesSendHelp = `Usage:
  privos hub messages send --room ROOM_ID --text TEXT

POST /api/v1/chat.sendMessage with {"message":{"rid":ROOM_ID,"msg":TEXT}}.
This is the user-token send method in the PrivOS API overview and in
Rocket.Chat. It takes a room id, so --kind is not used. Dry run unless --confirm.
`;

const hubMessagesUpdateHelp = `Usage:
  privos hub messages update --room ROOM_ID --id MSG_ID --text TEXT

POST /api/v1/chat.update with {"roomId","msgId","text"}. Dry run unless --confirm.
`;

const hubMessagesDeleteHelp = `Usage:
  privos hub messages delete --room ROOM_ID --id MSG_ID

POST /api/v1/chat.delete with {"roomId","msgId"}. asUser is omitted (server
default false). Dry run unless --confirm.
`;

const hubListsHelp = `Usage:
  privos hub lists <command>

Commands:
  list [--room ROOM_ID]
  get --id LIST_ID
  create --room ROOM_ID [--name NAME] [--description TEXT]
  update --id LIST_ID [--name NAME] [--description TEXT] [--room ROOM_ID]
  delete --id LIST_ID

Reads are GET /api/v1/lists.list, lists.listByRoomId, and lists.info.
Writes are POST /api/v1/lists.create, lists.update, and lists.delete, and
they stay a dry run unless --confirm. Auth is X-User-Id and X-Auth-Token.
Field CRUD (lists.addField, lists.fields.*) is not a CLI command.
See docs/api/hub.md.
`;

const hubListsListHelp = `Usage:
  privos hub lists list [--room ROOM_ID]

GET /api/v1/lists.list when --room is omitted.
GET /api/v1/lists.listByRoomId?roomId=ROOM_ID when --room is set.
The table view prints the "lists" array.
`;

const hubListsGetHelp = `Usage:
  privos hub lists get --id LIST_ID

GET /api/v1/lists.info?listId=LIST_ID. Prints JSON.
`;

const hubListsCreateHelp = `Usage:
  privos hub lists create --room ROOM_ID [--name NAME] [--description TEXT]
         [--field-definitions JSON] [--cross-team true|false] [--isolated true|false]

POST /api/v1/lists.create. roomId is required. fieldDefinitions is always
sent and defaults to []. --field-definitions replaces that default and must
be a JSON array. --cross-team sets crossTeamWorkflow. --isolated sets
isolatedList. Omitted booleans are left to the server. Dry run unless --confirm.
The response includes list and defaultStage. Pass defaultStage to
"hub items create --stage" when you need a stage id.
`;

const hubListsUpdateHelp = `Usage:
  privos hub lists update --id LIST_ID [--name NAME] [--description TEXT]
         [--room ROOM_ID] [--cross-team true|false] [--isolated true|false]

POST /api/v1/lists.update with listId plus at least one other field.
Dry run unless --confirm.
`;

const hubListsDeleteHelp = `Usage:
  privos hub lists delete --id LIST_ID

POST /api/v1/lists.delete with {"listId":"LIST_ID"}. Dry run unless --confirm.
`;

const hubItemsHelp = `Usage:
  privos hub items <command>

Commands:
  list --list LIST_ID
  get --id ITEM_ID
  search --list LIST_ID --term TEXT
  find --list LIST_ID --field FIELD_ID --value VALUE
  create --list LIST_ID --stage STAGE_ID [--name NAME]
  update --id ITEM_ID
  delete --id ITEM_ID
  move --id ITEM_ID --stage STAGE_ID
  reorder --id ITEM_ID --order N

Reads are GET /api/v1/items.*. Writes are POST and stay a dry run unless
--confirm. stages.* and items.bulkUpdateOrder are not CLI commands.
See docs/api/hub.md.
`;

const hubItemsListHelp = `Usage:
  privos hub items list --list LIST_ID [--include-sub-items]
  privos hub items list --list LIST_ID [--stage STAGE_ID] [--parent ITEM_ID]
                         [--count N] [--offset N] [--sort SORT] [--after CURSOR]
  privos hub items list --stage STAGE_ID
  privos hub items list --parent ITEM_ID

--list with no other item filter calls GET /api/v1/items.listByListId.
--include-sub-items adds includeSubItems=true and cannot be combined with
other filters. --stage, --parent, --count, --offset, --sort, or --after
together with --list call GET /api/v1/items.list. --stage alone calls
GET /api/v1/items.listByStageId. --parent alone calls
GET /api/v1/items.listByParentId. The table view prints the "items" array.
`;

const hubItemsGetHelp = `Usage:
  privos hub items get --id ITEM_ID

GET /api/v1/items.info?itemId=ITEM_ID. Prints JSON.
`;

const hubItemsSearchHelp = `Usage:
  privos hub items search --list LIST_ID --term TEXT

GET /api/v1/items.search?listId=LIST_ID&searchTerm=TEXT.
`;

const hubItemsFindHelp = `Usage:
  privos hub items find --list LIST_ID --field FIELD_ID --value VALUE

GET /api/v1/items.findByFieldValue?listId=LIST_ID&fieldId=FIELD_ID&value=VALUE.
`;

const hubItemsCreateHelp = `Usage:
  privos hub items create --list LIST_ID --stage STAGE_ID
         [--name NAME] [--description TEXT] [--parent ITEM_ID]
         [--custom-fields JSON]

POST /api/v1/items.create. listId and stageId are required.
--custom-fields must be a JSON array. There is no stages list command;
use the defaultStage from "hub lists create", or a stage id you already
have. Dry run unless --confirm.
`;

const hubItemsUpdateHelp = `Usage:
  privos hub items update --id ITEM_ID [--name NAME] [--description TEXT]
         [--stage STAGE_ID] [--custom-fields JSON] [--archived true|false]
         [--order N] [--show-archived-sub-items true|false]

POST /api/v1/items.update with itemId plus at least one other field.
--order here is the update body's "order" field, not items.updateOrder.
Use "hub items reorder" for {"itemId","newOrder"}. Dry run unless --confirm.
`;

const hubItemsDeleteHelp = `Usage:
  privos hub items delete --id ITEM_ID

POST /api/v1/items.delete with {"itemId":"ITEM_ID"}. Dry run unless --confirm.
`;

const hubItemsMoveHelp = `Usage:
  privos hub items move --id ITEM_ID --stage STAGE_ID

POST /api/v1/items.moveToStage with {"itemId","stageId"}. Dry run unless --confirm.
`;

const hubItemsReorderHelp = `Usage:
  privos hub items reorder --id ITEM_ID --order N

POST /api/v1/items.updateOrder with {"itemId","newOrder"}. --order is an
integer. Dry run unless --confirm. items.bulkUpdateOrder is not a command.
`;

const versionHelp = `Usage:
  privos version

Print the CLI version.
`;

const HELP: Record<string, string> = {
  "": rootHelp,
  sandbox: sandboxHelp,
  "sandbox projects": sandboxProjectsHelp,
  "sandbox projects list": sandboxProjectsListHelp,
  "sandbox projects create": sandboxProjectsCreateHelp,
  "sandbox projects update": sandboxProjectsUpdateHelp,
  "sandbox projects delete": sandboxProjectsDeleteHelp,
  "sandbox projects start": sandboxProjectsStartHelp,
  "sandbox tasks": sandboxTasksHelp,
  "sandbox tasks list": sandboxTasksListHelp,
  "sandbox tasks create": sandboxTasksCreateHelp,
  "sandbox tasks update": sandboxTasksUpdateHelp,
  "sandbox tasks delete": sandboxTasksDeleteHelp,
  "sandbox tasks start": sandboxTasksStartHelp,
  "sandbox tasks attempts": sandboxTasksAttemptsHelp,
  "sandbox tasks conversation": sandboxTasksConversationHelp,
  "sandbox tasks running": sandboxTasksRunningHelp,
  "sandbox tasks question": sandboxTasksQuestionHelp,
  "sandbox tasks answer": sandboxTasksAnswerHelp,
  "sandbox models": sandboxModelsHelp,
  "sandbox models list": sandboxModelsListHelp,
  hub: hubHelp,
  "hub rooms": hubRoomsHelp,
  "hub rooms list": hubRoomsListHelp,
  "hub rooms create": hubRoomsCreateHelp,
  "hub rooms update": hubRoomsUpdateHelp,
  "hub rooms delete": hubRoomsDeleteHelp,
  "hub messages": hubMessagesHelp,
  "hub messages list": hubMessagesListHelp,
  "hub messages send": hubMessagesSendHelp,
  "hub messages update": hubMessagesUpdateHelp,
  "hub messages delete": hubMessagesDeleteHelp,
  "hub lists": hubListsHelp,
  "hub lists list": hubListsListHelp,
  "hub lists get": hubListsGetHelp,
  "hub lists create": hubListsCreateHelp,
  "hub lists update": hubListsUpdateHelp,
  "hub lists delete": hubListsDeleteHelp,
  "hub items": hubItemsHelp,
  "hub items list": hubItemsListHelp,
  "hub items get": hubItemsGetHelp,
  "hub items search": hubItemsSearchHelp,
  "hub items find": hubItemsFindHelp,
  "hub items create": hubItemsCreateHelp,
  "hub items update": hubItemsUpdateHelp,
  "hub items delete": hubItemsDeleteHelp,
  "hub items move": hubItemsMoveHelp,
  "hub items reorder": hubItemsReorderHelp,
  version: versionHelp,
};

export function helpFor(path: string[]): string {
  return HELP[path.join(" ")] ?? "";
}

export { rootHelp };
