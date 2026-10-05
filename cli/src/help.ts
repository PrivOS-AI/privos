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
  hub rooms list
  hub rooms create
  hub rooms update
  hub rooms delete
  hub messages list
  hub messages send
  hub messages update
  hub messages delete
  hub lists, hub items     Reserved until user-token method names are confirmed
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
  tasks list|create|update|delete

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
  update --id ID [--title T] [--description TEXT] [--status STATUS] [--position N] [--chat-init true|false]
  delete --id ID

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

POST /api/tasks with a JSON body and the x-project-id header set to --project.
The board client sends projectId, title, and optionally description and status.
status is omitted unless --status is set. Known board statuses: todo,
in_progress, in_review, done, cancelled. Dry run unless --confirm.
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

const hubHelp = `Usage:
  privos hub [--url URL] [--user-id ID] [--auth-token TOKEN] <command>

Commands:
  rooms list|create|update|delete
  messages list|send|update|delete
  lists list|get              Reserved. Not wired to a live request yet
  items list|get              Reserved. Not wired to a live request yet

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
  list [--room ROOM_ID]    Reserved read for lists.*
  get --id LIST_ID         Reserved read for one list

Not wired to a live request yet: these commands parse flags and do not
send an HTTP request. The user-token REST method names for lists are not
confirmed. See docs/api/hub.md.

Auth, once wired: X-User-Id and X-Auth-Token
(PRIVOS_HUB_USER_ID, PRIVOS_HUB_AUTH_TOKEN).
`;

const hubListsListHelp = `Usage:
  privos hub lists list [--room ROOM_ID]

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`;

const hubListsGetHelp = `Usage:
  privos hub lists get --id LIST_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`;

const hubItemsHelp = `Usage:
  privos hub items <command>

Commands:
  list --list LIST_ID    Reserved read for items in one list
  get --id ITEM_ID       Reserved read for one item

Not wired to a live request yet: these commands parse flags and do not
send an HTTP request. See docs/api/hub.md.
`;

const hubItemsListHelp = `Usage:
  privos hub items list --list LIST_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`;

const hubItemsGetHelp = `Usage:
  privos hub items get --id ITEM_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
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
  "hub items": hubItemsHelp,
  "hub items list": hubItemsListHelp,
  "hub items get": hubItemsGetHelp,
  version: versionHelp,
};

export function helpFor(path: string[]): string {
  return HELP[path.join(" ")] ?? "";
}

export { rootHelp };
