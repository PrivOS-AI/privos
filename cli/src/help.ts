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
  sandbox attempts cancel   Stop a running attempt (alias: stop)
  sandbox attempts stop
  sandbox attempts steer    Send a message to a running attempt
  sandbox models list
  hub get                  Read any hub GET route with your own token
  hub rooms list
  hub rooms create
  hub rooms update
  hub rooms delete
  hub rooms members
  hub rooms invite
  hub rooms kick
  hub rooms archive
  hub dm reply             Ask the hub to post in an owner DM, Inbox or Assistant DM as the owner (agent VM only)
  hub agents list          List the agents you created
  hub triggers list        List agent triggers (cron, event, webhook), LLM and non-LLM
  hub triggers get         Print one agent trigger as JSON
  hub owner rooms          List the owner's DMs and Inbox (super agent, agent VM only)
  hub owner messages       Read one owner DM or the owner's Inbox (super agent, agent VM only)
  hub messages list
  hub messages send
  hub messages update
  hub messages delete
  hub files upload         Upload a local file to a room's File Management
  hub files folders        List a room's File Management folders
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
  hub items attach         Upload a local file and set it on an item's file field
  hub items fields get     Read an item's custom-field values (bot mode)
  hub items fields set     Set one custom-field value, or several (bot mode)
  hub items fields clear   Remove one custom-field value (bot mode)
  hub stages list          List the stages of a list
  hub stages create
  hub stages update
  hub stages delete
  hub fields list          List a list's field definitions with option ids (bot mode)
  hub fields get
  hub fields add
  hub fields update
  hub fields delete
  hub fields options add   Add, update or delete a SELECT / MULTI_SELECT option (bot mode)
  hub fields options update
  hub fields options delete
  hub api                  One raw hub call: METHOD /api/v1/... (writes need --confirm)
  agents a2a send          Send a bot-to-bot message as an agent bot (--bot-key)
  agents a2a members       List the roster bots of a team
  agents a2a chain         Read every row of one bot-to-bot chain
  agents a2a stop          Stop a chain you started
  agents a2a await         Register a one-time callback wake in a chain (--bot-key)
  agents a2a cancel        Cancel a registered await
  hub inbox                One read-only poll of messages and notifications
  subscribe                Read-only event daemon (hub, lists, files, board tasks)
  subscribe status         Heartbeat, cursor, lag, and outbox of the daemon
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
  attempts cancel|stop|steer
  models list

Environment (flags override):
  PRIVOS_SANDBOX_URL          Board base URL
  PRIVOS_SANDBOX_API_KEY      API key (preferred)
  API_ACCESS_KEY              Same key; the name the board process uses
  SANDBOX_API_KEY             Same key; the name install.sh writes
  PRIVOS_REQUESTER_ID         Who is asking (--requester)
  PRIVOS_REQUESTER_NAME       Display name (--requester-name)
  PRIVOS_REQUESTER_KIND       human or agent, default human (--requester-kind)

The key is sent as the x-api-key header. A default self-hosted board
listens on http://127.0.0.1:8556.

Requester claim: with --requester (or PRIVOS_REQUESTER_ID) every board
request also carries x-privos-requester-id, -name and -kind, and the answer
socket sends auth.requester, so the board records who started or answered an
attempt. Id and name are up to 64 printable ASCII characters. Flags win over
the environment. --requester-name and --requester-kind need --requester.
The claim is self-declared unless the board binds the key to an identity.
Dry runs print the claim headers and never the key.

Writes (create, update, delete, start, answer, cancel, steer) print the request and send nothing
unless --confirm is set.

Global flags:
  --requester ID              Requester claim id (see above)
  --requester-name NAME       Requester display name
  --requester-kind KIND       human (default) or agent
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
  start --id ID [--model M] [--provider P | --llm-provider ID] [--effort E] [--prompt TEXT] [--force]
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
         [--callback-url-env NAME --callback-key-env NAME]

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
"privos sandbox tasks start" and need --start. A new task has no previous
attempt, so the attempt is sent with "provider":"claude-cli" unless you pass
--provider or --llm-provider.

--callback-url-env and --callback-key-env name environment variables that hold the callback
URL and secret printed by "privos agents a2a await"; the task then POSTs once when it leaves
in_progress. The values are read from the environment only, never from argv, and the dry run
shows the URL host and secret: "<set>". Both flags go together; the board accepts only a hub
callback URL.
`;

const sandboxTasksUpdateHelp = `Usage:
  privos sandbox tasks update --id ID [flags]

Title, description, and chat init use PATCH /api/tasks/{id}. The board client
sends {"title"}, {"description"}, or {"chatInit":true|false}.

Status uses PUT /api/tasks/reorder with {"taskId","status","position"}. That
is how the board moves a card. When --position is omitted, position is
-Date.now(), which is what the board client sends on a status change. The
request carries the x-project-id header; the CLI reads GET /api/tasks/{id}
first to learn the project (that read also runs in a dry run).

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
     with the x-project-id header, only when the task is not already
     in_progress
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

Runtime: --provider, --model and --llm-provider that you pass always win. For
each one you leave out, the attempt reuses the runtime of the task's newest
attempt that has a provider (provider, model, and the custom provider id that
went with that model), else the task's last provider and model, else
"provider":"claude-cli". Passing --provider drops the inherited model, since
it belongs to another runtime; passing only --model keeps the inherited
provider. The dry run shows the body that will be sent.
Dry run unless --confirm.
`;

const sandboxTasksAttemptsHelp = `Usage:
  privos sandbox tasks attempts --id ID

List a task's attempts from GET /api/tasks/{id}/attempts. This read has no
side effects. --format table shows ID, STATUS, MODEL, PROVIDER, CREATED and
REQUESTER (the requester id; JSON has the full requester record).
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

The CLI reads GET /api/tasks/{id}, GET /api/tasks/{id}/pending-question and
GET /api/tasks/{id}/attempts, then sends
POST /api/attempts/{attemptId}/answer
{"projectId","workspaceId"?,"toolUseId","questions","answers"} with the
x-project-id header. "answers" maps each question text to its --answer.
workspaceId is sent only when the attempt or its task has one (hub tasks).
HTTP 200 means the answer was delivered.

Only two board replies make the CLI fall back to the socket.io event
question:answer (websocket, the API key as the handshake auth token):
  - HTTP 400 "projectId, workspaceId, toolUseId, questions, and answers are
    required" (an older board)
  - HTTP 404 "No matching pending question for this attempt" or "No pending
    question for this attempt" (the board kept the question but no agent is
    waiting; the socket path restarts the agent)
Right before the emit the CLI re-reads the pending question and stops if it
changed. Any other reply is a failure (exit 1). The socket counts as delivered
when the board acks it, or, when no ack comes (sandbox mode), once a re-read
shows the question gone.

A question that asks for a secret (the vault form) is refused with exit 2:
answer it in the hub or the board, never through text.

The dry run reads the question and prints both requests; it sends nothing.
Output: {"answered","attemptId","toolUseId","via","confirmedBy"} with via
"rest" or "socket". Dry run unless --confirm.
`;

const sandboxAttemptsHelp = `Usage:
  privos sandbox attempts <command>

Commands:
  cancel --id ATTEMPT_ID    Stop a running attempt (alias: stop)
  stop --id ATTEMPT_ID
  steer --id ATTEMPT_ID --text TEXT

Writes require --confirm. The default is a dry run.
`;

const sandboxAttemptsCancelHelp = `Usage:
  privos sandbox attempts cancel --id ATTEMPT_ID
  privos sandbox attempts stop --id ATTEMPT_ID

Stop an attempt. "stop" is the same command as "cancel".

The CLI first reads GET /api/attempts/{id}/status for the task, project and
workspace ids (an older board returns only the status, so the CLI then reads
GET /api/attempts/{id}, which is large and has no ids for an attempt stored
with a non-json output format). Those reads also run in a dry run. Then it
sends POST /api/attempts/{id}/cancel {"projectId","workspaceId"?} with the
x-project-id header. Dry run unless --confirm.

Output is the board's reply: {"attemptId","status","cancelled","replayed"}.
Exit codes:
  0  the attempt is no longer running ("cancelled": true, or "replayed": true
     for an attempt that had already ended)
  1  the board did not stop it (an HTTP 2xx reply with "cancelled": false is still
     printed), or it answered an error status (only the error message is printed)
  2  usage error, nothing was sent
An older board answers HTTP 400 "projectId and workspaceId are required" for
an attempt that has no workspace; upgrade the board.
`;

const sandboxAttemptsSteerHelp = `Usage:
  privos sandbox attempts steer --id ATTEMPT_ID --text TEXT

Send a message to a running attempt without stopping it.

The CLI reads the attempt's ids as "privos sandbox attempts cancel --help"
describes, then GET /api/tasks/{taskId}/pending-question. When that question
belongs to this attempt the agent is waiting for an answer and a steer cannot
reach it, so the CLI stops (exit 1) and prints the answer command. Otherwise it
sends POST /api/attempts/{id}/steer {"projectId","workspaceId"?,"text"} with
the x-project-id header. Dry run unless --confirm.

Output is the board's reply: {"outcome","blockedOnQuestion","pendingQuestion"?}.
Exit codes:
  0  "outcome": "accepted"
  1  "notRunning" (the attempt is not running), "unsupported" (the runtime
     cannot take a mid-turn message), or any other outcome
  2  usage error (for example a missing --text), nothing was sent
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
  get --route ROUTE [--param k=v]
  rooms list|members|create|update|delete|invite|kick|archive
  messages list|send|update|delete
  files upload|folders
  lists list|get|create|update|delete
  items list|get|search|find|create|update|delete|move|reorder|attach
  items fields get|set|clear
  stages list|create|update|delete
  fields list|get|add|update|delete
  fields options add|update|delete
  api METHOD /api/v1/... [--body JSON] [--query k=v]
  dm reply --room DM_ROOM_ID --text TEXT
  owner rooms|messages
  agents list
  triggers list|get
  inbox --since TIME

Environment (flags override):
  PRIVOS_HUB_URL          Hub base URL
  PRIVOS_ROOT_URL         Used when PRIVOS_HUB_URL is unset (installer)
  PRIVOS_HUB_USER_ID      X-User-Id (PRIVOS_USER_ID also works)
  PRIVOS_HUB_AUTH_TOKEN   X-Auth-Token (PRIVOS_PAT also works)
  PRIVOS_BOT_KEY          An agent bot key, sent as Authorization: Bearer instead of
                          the two headers above (--bot-key; not used by subscribe or inbox)

A default self-hosted hub listens on http://127.0.0.1:3000
(PRIVOS_HUB_PORT). Create a personal access token in the hub UI, or
POST /api/v1/login, and pass that user id and token. The CLI does not
log in and does not read passwords.

Writes print the request and send nothing unless --confirm is set.
Global flags: --format json|table, --raw, --timeout SECONDS, --confirm, --dry-run.

Bot mode (an agent bot, not a person):
  --bot-key or PRIVOS_BOT_KEY runs the command as that agent bot. Bot keys cannot use the
  public lists.*, items.* and stages.* routes, so "lists" and "items" call the room routes
  /api/v1/internal/rooms/ROOM_ID/... instead. --room is required there; PRIVOS_ROOM_ID is the
  default. See "privos hub lists --help" and "privos hub items --help" for what the room routes
  leave out. Personal-token mode is unchanged.

Sandbox egress (inside an agent VM):
  An agent VM holds no bot key. With PRIVOS_SANDBOX_MODE=true, PROXY_URL and PROXY_TOKEN set and
  no credential of your own, the commands "hub rooms", "hub messages", "hub files", "hub lists",
  "hub items", "hub stages", "hub fields", "hub api", "hub dm", "hub owner", "hub agents",
  "hub triggers" and "agents a2a" send every
  PrivOS Hub request through POST $PROXY_URL/egress, and the proxy
  attaches the bot key. The hub is --url, else PRIVOS_HUB_URL, else https://$PRIVOS_HUB_HOST.
  The proxy decides what an agent may call: a refusal prints its code first, for example
  "no-binding: no catalog entry for this domain". "hub get", "subscribe" and
  "sandbox tasks answer" never use the egress; they need their own connection.
`;

const hubRoomsHelp = `Usage:
  privos hub rooms <command>

Commands:
  list [--updated-since RFC3339]
  members --room ID [--kind channel|group]
  create --name NAME [--kind channel|group] [--member USER] [--read-only] [--exclude-self]
  update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]
  delete --room ID [--kind channel|group]
  invite --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]
  kick --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]
  archive --room ID [--kind channel|group]

Writes require --confirm. Direct messages (--kind direct) are not a write target.
In bot mode (an agent bot over the sandbox egress) the rooms an agent manages are
create, invite, kick, archive and rename ("update --name"), plus list and members;
"update --topic" and "delete" are not available there.
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

const hubRoomsMembersHelp = `Usage:
  privos hub rooms members --room ID [--kind channel|group]

GET /api/v1/channels.members?roomId=ID (kind channel, the default) or
groups.members. Prints the members with their user ids; invite and kick take
those ids. The table view prints the "members" array.
`;

const hubRoomsInviteHelp = `Usage:
  privos hub rooms invite --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]

POST /api/v1/channels.invite (kind channel, the default) or groups.invite with
{"roomId","userIds"}. --member here is a user id, not a username (unlike
"rooms create"). Dry run unless --confirm.
`;

const hubRoomsKickHelp = `Usage:
  privos hub rooms kick --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]

POST /api/v1/channels.kick or groups.kick with {"roomId","userId"}, one request
per --member (a user id). --kind defaults to channel. Dry run unless --confirm.
`;

const hubRoomsArchiveHelp = `Usage:
  privos hub rooms archive --room ID [--kind channel|group]

POST /api/v1/channels.archive or groups.archive with {"roomId"}. --kind defaults
to channel. Dry run unless --confirm.
`;

const hubDmHelp = `Usage:
  privos hub dm <command>

Commands:
  reply --room DM_ROOM_ID --text TEXT

Run privos hub dm reply --help.
`;

const hubDmReplyHelp = `Usage:
  privos hub dm reply --room DM_ROOM_ID --text TEXT [--url URL]

POST /api/v1/agents.superAgent.dmReply with {"roomId","text"}: a super agent asks
the PrivOS Hub to post in the owner's name in one of these rooms of its owner:
  a one-to-one DM with a person (an answer to that person),
  the owner's Inbox, or the owner's DM with the Universal Assistant. A message
  there asks the Universal Assistant, which then works with the owner's access.
  Its answer never wakes the agent: read it with privos hub owner messages.
The hub posts the message as the owner, with a "sent by <agent>" badge, in one of
two ways that the owner chose and the agent cannot change:
  status drafted  A draft card appears in the agent room. Nothing reaches the DM
                  until the owner presses Send there.
  status sent     The owner allowed replies on their behalf; the message is
                  posted at once, and the agent room gets a one-line note.
A second reply for the same DM replaces the pending draft.

This works only inside an agent VM, over the sandbox egress: the hub accepts the
call only from the agent room session. A personal token or a bare --bot-key is
refused here before any request. Dry run unless --confirm. Errors print the hub's
code first, for example error-not-owner-dm or error-super-agent-inactive.
`;

const hubAgentsHelp = `Usage:
  privos hub agents <command>

Commands:
  list                    The agents you created
`;

const hubAgentsListHelp = `Usage:
  privos hub agents list [--url URL] [--user-id ID] [--auth-token TOKEN] [--format json|table]

GET /api/v1/agents.mine: the agents the caller created (not agents it only owns or leads
in an agent room; use "triggers list --agent" for those). Columns: ID, USERNAME, NAME,
ACTIVE, RUNTIME, SUPER, ROOM. Personal token only: the hub lists no agents to a bot, so
in bot mode use privos agents a2a members --team TEAM_ID for an agent team's roster.
`;

const hubTriggersHelp = `Usage:
  privos hub triggers <command>

Commands:
  list [--agent AGENT | --all]
  get --id TRIGGER_ID [--agent AGENT | --all]

Reads only (GET); no --confirm is needed and nothing is changed.
`;

const hubTriggersListHelp = `Usage:
  privos hub triggers list [--agent BOT_ID|USERNAME|AGENT_ROOM_ID | --all] [--bot-key KEY]
                           [--url URL] [--user-id ID] [--auth-token TOKEN] [--format json|table]

Routes (GET): agents.mine, then agents.triggers.list?botId= per agent; --all uses
agents.triggers.list-all (administrator only). JSON is { triggers, total, errors? }; a
failing agent is listed in errors, the others still print, and the exit code is 1.

--agent takes an agent id, username, agent room id, or a name that only one of your agents
has; anything else is looked up with users.info. The resolved agent is printed to stderr.
--agent with --all is a usage error.

KIND tells how a trigger runs: llm (wakes the agent), no-llm (emits an event, no model) or
handler:NAME (runs a handler script). ENABLED shows "false (needs review)" for a trigger a
migration disabled until its owner checks it. Event triggers fire today only for
message.new and notification.created. A hidden (inactive) agent's crons still fire.

Who may read: the agent's creator, the agent-room owner or leader, or an administrator. A
super agent's triggers are readable by its owner, an administrator, or the agent itself from
its own agent room session over the sandbox egress; a bare bot key or a room-scoped session
is refused by the hub. A webhook token is never printed: rows carry hasWebhook and
webhookTokenFingerprint (first 8 hex of its SHA-256).

Bot mode (--bot-key, PRIVOS_BOT_KEY or the egress) reads this agent's own triggers, using
PRIVOS_BOT_ID. --agent BOT_ID (an id or agent-room-ID; names are not resolved in bot mode)
asks the hub for a peer's triggers: allowed for a peer with the same owner or on a shared
agent team, from the agent room or the chain room, and directly only when the person behind
the turn owns the peer; the answer is a reduced view without prompt text (PROMPT is empty,
"peer read: reduced view, no prompt text" on stderr). Otherwise the hub refuses with
error-peer-owner-approval-required and the peer's owner approves on a card (agents send
needs-approval --action trigger-read). --all stays refused in bot mode. --raw, --confirm
and --dry-run are not supported.
`;

const hubTriggersGetHelp = `Usage:
  privos hub triggers get --id TRIGGER_ID [--agent BOT_ID|USERNAME|AGENT_ROOM_ID | --all]
                          [--bot-key KEY] [--url URL] [--user-id ID] [--auth-token TOKEN]

Prints the first trigger whose id matches as one JSON object, from the same sources as
"hub triggers list" (same flags, same rules; webhook tokens are fingerprinted). A missing id
is an error. --format table is not supported.
`;

const hubOwnerHelp = `Usage:
  privos hub owner <command>

Commands:
  rooms                   The owner's one-to-one DMs and Inbox
  messages --room RID     Messages of one of those rooms

A super agent reads its owner's DMs, the owner's Inbox and the owner's DM with
the Universal Assistant without joining them. Only inside an agent VM, over the
sandbox egress, from the agent's own agent room. Every read is audited.
`;

const hubOwnerRoomsHelp = `Usage:
  privos hub owner rooms [--count N] [--offset N] [--url URL]

GET /api/v1/agents.superAgent.ownerRooms: the owner's one-to-one DMs (kind dm,
with the other person or bot as counterpart; the Universal Assistant DM is one
of them) and the owner's Inbox (kind inbox), newest activity first. Group DMs
are not included. Use an id with privos hub owner messages --room.

Only inside an agent VM, over the sandbox egress: the hub answers only a super
agent asking from its own agent room. A personal token or a bare --bot-key is
refused here before any request.
`;

const hubOwnerMessagesHelp = `Usage:
  privos hub owner messages --room RID [--count N] [--offset N]
                            [--oldest ISO] [--latest ISO] [--url URL]

GET /api/v1/agents.superAgent.ownerMessages: messages of one of the owner's
one-to-one DMs or the owner's Inbox, newest first, threads included. --oldest
and --latest bound the time range. Reading never marks anything read for the
owner. Errors print the hub's code first.

Only inside an agent VM, over the sandbox egress (see privos hub owner rooms).
`;

const hubMessagesHelp = `Usage:
  privos hub messages <command>

Commands:
  list --room ROOM_ID [--kind channel|group|direct]
  send --room ROOM_ID --text TEXT
  send --room ROOM_ID --file PATH [--text TEXT]
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
  privos hub messages send --room ROOM_ID --file PATH [--text TEXT]

POST /api/v1/chat.sendMessage with {"message":{"rid":ROOM_ID,"msg":TEXT}}.
This is the user-token send method in the PrivOS API overview and in
Rocket.Chat. It takes a room id, so --kind is not used. Dry run unless --confirm.

--file posts a local file (image, video, audio, document, any type) as a chat
attachment: one multipart POST /api/v1/rooms.upload/ROOM_ID with the file
under "file" and --text, when set, as the message "msg". The content type comes
from the file extension (application/octet-stream when unknown); images and
videos are shown inline. The hub caps the size at its FileUpload_MaxFileSize
setting. The dry run prints the file's name, type and size, never its bytes.
Works with a personal token, a bot key, and over the sandbox egress.
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

const hubFilesHelp = `Usage:
  privos hub files <command>

Commands:
  upload --room ROOM_ID --file PATH [--folder FOLDER_ID] [--duplicate replace|keep_both|cancel]
  folders --room ROOM_ID [--parent FOLDER_ID]

The room's File Management (the Files tab), not chat attachments; post a file
into the chat with "hub messages send --file". --room defaults to
PRIVOS_ROOM_ID. Writes require --confirm.
`;

const hubFilesUploadHelp = `Usage:
  privos hub files upload --room ROOM_ID --file PATH [--folder FOLDER_ID]
         [--duplicate replace|keep_both|cancel]

Multipart POST /api/v1/file-management.files.upload with the file under
"files" and channelId, folderId and duplicateAction as fields. Without
--folder the file goes to the room's top level; "hub files folders" lists
folder ids. When the folder already holds a file of that name the hub refuses
with DUPLICATE_FILE unless --duplicate says what to do: replace (same file id,
new content), keep_both (the new file gets a numbered name) or cancel.

Any file type; the content type comes from the extension. The room's Auto
Parse setting decides whether the file is parsed. --room defaults to
PRIVOS_ROOM_ID. Dry run unless --confirm; the dry run prints the file's name,
type and size, never its bytes. Works with a personal token, a bot key, and
over the sandbox egress.
`;

const hubFilesFoldersHelp = `Usage:
  privos hub files folders --room ROOM_ID [--parent FOLDER_ID] [--count N] [--offset N]

GET /api/v1/file-management.folders.channel/ROOM_ID: the folders at the room's
top level, or under --parent (sent as fatherId). The hub pages by 50 unless
--count is set. The table view prints ID, NAME and PATH. --room defaults to
PRIVOS_ROOM_ID.
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
they stay a dry run unless --confirm. Auth is X-User-Id and X-Auth-Token, or an
agent bot key (--bot-key, PRIVOS_BOT_KEY) or the sandbox egress of an agent VM.
Field CRUD (lists.addField, lists.fields.*) is not a CLI command.
See docs/api/hub.md.

Bot mode (bot key or egress): the commands call the room routes
GET|POST /api/v1/internal/rooms/ROOM_ID/lists and GET|PUT|DELETE
/api/v1/internal/rooms/ROOM_ID/lists/LIST_ID. --room names the room and is
required (default PRIVOS_ROOM_ID); "update --room" does not move a list there.
"create" needs --name and sends --stages as the body's stages, so no stage
"Ungroup" is made. --isolated is refused. "get" prints list, stages and
itemCount like personal-token mode. Structure changes still need the room's
owner, admin or leader role.
`;

const hubGetHelp = `Usage:
  privos hub get --route ROUTE [--param key=value ...]

GET /api/v1/ROUTE?key=value with your X-User-Id and X-Auth-Token. Prints the
JSON body (--format table is not supported). ROUTE is a hub route such as
channels.members; a leading /api/v1/ is dropped. --param repeats.
Bot keys are refused: --bot-key and PRIVOS_BOT_KEY do not apply. The hub
applies your own permissions and answers 4xx when the route is not yours.
Example: privos hub get --route channels.members --param roomId=GENERAL
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
         [--stages STAGES]

POST /api/v1/lists.create. roomId is required. fieldDefinitions is always
sent and defaults to []. --field-definitions replaces that default and must
be a JSON array. --cross-team sets crossTeamWorkflow. --isolated sets
isolatedList. Omitted booleans are left to the server. Dry run unless --confirm.
The response includes list and defaultStage. Pass defaultStage to
"hub items create --stage" when you need a stage id.

--stages is a JSON array of {"name","color"}, color optional (#RRGGBB). It is
recommended to give each stage a color that fits its state. Without --stages the hub makes one gray "Ungroup"
stage. With --stages the CLI renames that stage to the first one
(POST /api/v1/stages.update) and adds the rest in order (POST /api/v1/stages.create).
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
  attach --id ITEM_ID --field FIELD_ID --file PATH --room ROOM_ID
  fields get|set|clear --id ITEM_ID     Custom-field values (bot mode)

Reads are GET /api/v1/items.*. Writes are POST and stay a dry run unless
--confirm. items.bulkUpdateOrder is not a CLI command; "hub stages" covers
stages and "hub items fields" an item's custom-field values.
See docs/api/hub.md.

Bot mode (bot key or egress): list, get, create, update, delete and move call
/api/v1/internal/rooms/ROOM_ID/items... instead. --room names the room and is
required (default PRIVOS_ROOM_ID). "create" needs --name. The room routes have
no search, find or reorder (those commands are refused) and no --parent,
--sort, --after, --include-sub-items, --archived, --order or
--show-archived-sub-items (refused rather than ignored). "list" takes exactly
one of --list (with --count, --offset) or --stage (whole stage, up to 100).
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
--custom-fields must be a JSON array of {"fieldId","value"}; a SELECT value
is the option's _id ("hub fields list" shows both). "hub stages list --list
LIST_ID" shows the stage ids. Dry run unless --confirm.
`;

const hubItemsUpdateHelp = `Usage:
  privos hub items update --id ITEM_ID [--name NAME] [--description TEXT]
         [--stage STAGE_ID] [--custom-fields JSON] [--archived true|false]
         [--order N] [--show-archived-sub-items true|false]

POST /api/v1/items.update with itemId plus at least one other field.
--order here is the update body's "order" field, not items.updateOrder.
Use "hub items reorder" for {"itemId","newOrder"}. Dry run unless --confirm.
`;

const hubItemsAttachHelp = `Usage:
  privos hub items attach --id ITEM_ID --field FIELD_ID --file PATH --room ROOM_ID
         [--duplicate replace|keep_both|cancel]

Attaches a local file (image, video, document, any type) to a list item the
way the item panel does. It reads the item and its list, then:
  1. finds or creates the item folder Uploads/list-items/ITEM_ID in the room's
     File Management (POST /api/v1/file-management.folders.create),
  2. uploads the file there (multipart POST /api/v1/file-management.files.upload),
  3. reads the uploaded file for its download URL
     (GET /api/v1/file-management.files/FILE_ID; skipped over the sandbox
     egress, which does not open it: the field then keeps the file id),
  4. sets the field: PUT /api/v1/internal/rooms/ROOM_ID/items/ITEM_ID/customFields/FIELD_ID.
A FILE field gets the file in place of its old one; a FILE_MULTIPLE or
DOCUMENT field keeps its files and gets this one added. Other fields are left
unchanged. Any other field type is refused before a write.

--room is the item's room (default PRIVOS_ROOM_ID); "hub lists get" shows the
field ids. --duplicate is passed to the upload (see "hub files upload").
The reads run in a dry run too, so the preview shows the real folder ids and
the field's new value. Dry run unless --confirm. Works with a personal token,
a bot key, and over the sandbox egress.
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

const hubStagesHelp = `Usage:
  privos hub stages <command>

Commands:
  list --list LIST_ID
  create --list LIST_ID --name NAME [--color #RRGGBB] [--order N]
  update --id STAGE_ID [--name NAME] [--color #RRGGBB] [--order N]
  delete --id STAGE_ID [--move-to STAGE_ID]

Bot mode (bot key or egress) calls /api/v1/internal/rooms/ROOM_ID/stages...
(--room, default PRIVOS_ROOM_ID). A personal token calls stages.listByListId,
stages.create, stages.update and stages.delete. Writes are a dry run unless --confirm.
`;

const hubStagesListHelp = `Usage:
  privos hub stages list --list LIST_ID

GET /api/v1/internal/rooms/ROOM_ID/stages?listId=LIST_ID in bot mode, else
GET /api/v1/stages.listByListId. --format table shows ID, NAME, ORDER, COLOR.
`;

const hubStagesCreateHelp = `Usage:
  privos hub stages create --list LIST_ID --name NAME [--color #RRGGBB] [--order N]

POST /api/v1/internal/rooms/ROOM_ID/stages with {"listId","name","color","order"}
in bot mode, else POST /api/v1/stages.create. Without --order the stage goes last.
Dry run unless --confirm.
`;

const hubStagesUpdateHelp = `Usage:
  privos hub stages update --id STAGE_ID [--name NAME] [--color #RRGGBB] [--order N]

PUT /api/v1/internal/rooms/ROOM_ID/stages/STAGE_ID in bot mode, else POST
/api/v1/stages.update (no --order there). Dry run unless --confirm.
`;

const hubStagesDeleteHelp = `Usage:
  privos hub stages delete --id STAGE_ID [--move-to STAGE_ID]

DELETE /api/v1/internal/rooms/ROOM_ID/stages/STAGE_ID in bot mode, else POST
/api/v1/stages.delete. A stage that still has items is refused unless
--move-to names the stage (same list) that receives them. Dry run unless --confirm.
`;

const hubFieldsHelp = `Usage:
  privos hub fields <command>

Commands:
  list --list LIST_ID
  get --list LIST_ID --field FIELD_ID
  add --list LIST_ID --name NAME --type TYPE [--options JSON] [--display-format JSON] [--order N]
  update --list LIST_ID --field FIELD_ID [--name] [--type] [--options] [--display-format] [--order]
  delete --list LIST_ID --field FIELD_ID
  options add --list LIST_ID --field FIELD_ID --name LABEL [--color #RRGGBB] [--order N]
  options update --list LIST_ID --field FIELD_ID --option OPTION_ID [--name] [--color] [--order]
  options delete --list LIST_ID --field FIELD_ID --option OPTION_ID

Field definitions of a list, through /api/v1/internal/rooms/ROOM_ID/lists/LIST_ID/fields...
Bot mode only (a bot key or the sandbox egress); --room defaults to PRIVOS_ROOM_ID.
TYPE is one of TEXT, TEXTAREA, NUMBER, DATE, DATE_TIME, SELECT, MULTI_SELECT,
USER, CHECKBOX, URL, FILE, FILE_MULTIPLE, DOCUMENT, ASSIGNEE, DEADLINE,
DEPENDENCIES, RECURRING. Writes are a dry run unless --confirm.
`;

const hubFieldsListHelp = `Usage:
  privos hub fields list --list LIST_ID

GET .../lists/LIST_ID/fields: every field definition with its _id, type and,
for SELECT and MULTI_SELECT, its options[]._id. An item's SELECT value is the
option's _id, never its label. --format table shows ID, NAME, TYPE, ORDER.
`;

const hubFieldsGetHelp = `Usage:
  privos hub fields get --list LIST_ID --field FIELD_ID

GET .../lists/LIST_ID/fields/FIELD_ID.
`;

const hubFieldsAddHelp = `Usage:
  privos hub fields add --list LIST_ID --name NAME --type TYPE
         [--options JSON] [--display-format JSON] [--order N]

POST .../lists/LIST_ID/fields with {"field":{...}}. A SELECT or MULTI_SELECT
field needs --options, a JSON array where every option has its own "_id" and
a "value", e.g. [{"_id":"opt_high","value":"High","color":"#ef4444"}]. Bot mode
only. Dry run unless --confirm.
`;

const hubFieldsUpdateHelp = `Usage:
  privos hub fields update --list LIST_ID --field FIELD_ID [--name NAME] [--type TYPE]
         [--options JSON] [--display-format JSON] [--order N]

Reads the field (also in a dry run), keeps its name and type unless you pass
new ones, then PUT .../lists/LIST_ID/fields/FIELD_ID with {"data":{...}}.
--options replaces the whole option list. Bot mode only. Dry run unless --confirm.
`;

const hubFieldsDeleteHelp = `Usage:
  privos hub fields delete --list LIST_ID --field FIELD_ID

DELETE .../lists/LIST_ID/fields/FIELD_ID. Bot mode only. Dry run unless --confirm.
`;

const hubFieldOptionsHelp = `Usage:
  privos hub fields options add --list LIST_ID --field FIELD_ID --name LABEL [--color #RRGGBB] [--order N]
  privos hub fields options update --list LIST_ID --field FIELD_ID --option OPTION_ID
         [--name LABEL] [--color #RRGGBB] [--order N]
  privos hub fields options delete --list LIST_ID --field FIELD_ID --option OPTION_ID

One option of a SELECT or MULTI_SELECT field: POST, PUT or DELETE
.../lists/LIST_ID/fields/FIELD_ID/options[/OPTION_ID]. --name is the option's
label (the hub's "value"); the hub picks the new option's _id. Bot mode only.
Dry run unless --confirm.
`;

const hubItemsFieldsHelp = `Usage:
  privos hub items fields get --id ITEM_ID
  privos hub items fields set --id ITEM_ID --field FIELD_ID --value JSON
  privos hub items fields set --id ITEM_ID --custom-fields JSON
  privos hub items fields clear --id ITEM_ID --field FIELD_ID

An item's custom-field values through
/api/v1/internal/rooms/ROOM_ID/items/ITEM_ID/customFields[/FIELD_ID].
Both "set" forms send PUT .../customFields with {"fields":[{"fieldId","value"}...]},
which changes only the fields named. --value is JSON (a string, number,
boolean, array, object or null); text that is not JSON is sent as a string.
A SELECT value is the option's _id; MULTI_SELECT is an array of ids. Bot mode only. Writes are a dry run unless --confirm.
`;

const hubApiHelp = `Usage:
  privos hub api METHOD /api/v1/PATH [--body JSON] [--query key=value ...] [--room ROOM_ID]

One raw hub call for routes that have no named command, for example
  privos hub api POST /api/v1/internal/rooms/{room}/items/batch-move --body '{"itemIds":["a"],"stageId":"s"}' --confirm
  privos hub api GET /api/v1/internal/rooms/{room}/lists/byTemplateKey --query templateKey=crm

METHOD is GET, POST, PUT or DELETE. PATH starts with /api/v1/ and holds only
letters, digits, ".", "_", "-" and "/" (no query string, fragment, space or
".."); pass query values with --query (repeatable). --body (JSON) is for POST
and PUT. {room} anywhere in PATH, a --query value or --body stands for the room:
--room, else PRIVOS_ROOM_ID (inside an agent VM, the agent's own room). GET prints the answer as it came. Every other method is a dry run
unless --confirm. Auth is the same as the other hub commands; inside an agent
VM the call goes through the sandbox egress and the proxy decides what is allowed.
`;

const agentsHelp = `Usage:
  privos agents a2a <command>

Commands:
  a2a send|members|chain|stop|await|cancel    Bot-to-bot (a2a) messages between roster bots

Run privos agents a2a --help.
`;

const agentsA2aHelp = `Usage:
  privos agents a2a [--url URL] [--bot-key KEY] <command>

Commands:
  send [--team TEAM_ID] --room ROOM_ID --to BOT_ID,...|team --kind KIND [--text TEXT]
  members --team TEAM_ID
  chain --correlation C_ID
  stop --correlation C_ID
  await --correlation C_ID --room ROOM_ID --deadline-at ISO --text TEXT
  cancel --row ROW_ID

These call the hub routes agents.a2a.send, agents.a2a.team.members,
agents.a2a.list, agents.a2a.await and agents.a2a.await.cancel. They authenticate as an agent bot, not as a human:

Environment (flags override):
  PRIVOS_HUB_URL          Hub base URL
  PRIVOS_ROOT_URL         Used when PRIVOS_HUB_URL is unset (installer)
  PRIVOS_BOT_KEY          The bot's key, sent as Authorization: Bearer
                          (X-User-Id and X-Auth-Token are not sent)

The hub accepts a send only from an agent bot. A human personal access token is
refused with a2a-sender-ineligible, and an agent bot cannot mint a personal
access token, so use the bot key. A recipient is reachable when it has the same
owner as the bot, when both are on an agent team (--team) whose room each owner
enabled for streaming, or, in the room the bot acts in, when its owner enabled
streaming and "Allow everyone using this Agent" there. A caller holding a bot
key is treated as acting in that bot's own agent room, so a send to any other
room is a cross-room call: allowed for the same owner (who must be a member of
the room) and for a streaming team, refused otherwise (a2a-owner-mismatch).

Pairing with privos subscribe: send with agents a2a send, then watch the
results arrive in the team room with privos subscribe (a human credential: it
reads the room as you). Read one chain on demand with agents a2a chain.

A refusal prints the hub's error code first, for example
"a2a-owner-mismatch: ...". Sends are a dry run unless --confirm is set.
Inside an agent VM with no bot key of its own, the requests go through the
sandbox egress (see privos hub --help).
Global flags: --format json|table, --raw, --timeout SECONDS, --confirm, --dry-run.
`;

const agentsA2aSendHelp = `Usage:
  privos agents a2a send [--team TEAM_ID] --room ROOM_ID --to BOT_ID,...|team --kind KIND
                         [--correlation C_ID] [--reply-to M_ID] [--priority urgent|fyi]
                         [--text TEXT] [--data JSON_OBJECT] [--file-id ID]...
                         [--deadline-at ISO] [--message-id M_ID]

POST /api/v1/agents.a2a.send with one envelope. --room is the destination room
(a room both bots are members of). --kind is task, result, message,
needs-approval, question, or stop. --to is bot ids separated by commas, or the
word team for every roster bot in the room except you (needs --team). --team
names the agent team; leave it out for the same-owner and same-room paths.

Omit --correlation to start a new chain: the hub mints the id and prints it in
the response. Later messages carry it and the chain's team and room. --reply-to
names the messageId of a message addressed to you. --priority defaults to fyi
for message and urgent for every other kind. --data is a JSON object (for
needs-approval, {"approval":{"action":"...","draft":"..."}}; for question,
{"options":["a","b"]}). --file-id is repeatable. The CLI generates --message-id
(the idempotency key) unless you pass one; reuse it only to retry the same send.

Authentication is the bot key (--bot-key or PRIVOS_BOT_KEY). Dry run unless
--confirm.
`;

const agentsA2aAwaitHelp = `Usage:
  privos agents a2a await --correlation C_ID --room ROOM_ID --deadline-at ISO --text TEXT
                          [--team TEAM_ID] [--reply-to M_ID] [--message-id M_ID]
                          [--match-event EVENT --match-room ROOM_ID] [--bot-key KEY]

POST /api/v1/agents.a2a.await. Registers an await in an existing chain: the bot is woken
once, in that chain, when the one-time callback URL is called, when a matching room event
happens, or at --deadline-at, whichever comes first. --deadline-at is required (ISO
date-time, in the future). --match-event is message.new, file.created, file.updated or
file.deleted and needs --match-room (the bot must be a member of it). --reply-to names a
message addressed to this bot; the wake answers its sender. The CLI generates --message-id
(the idempotency key) unless you pass one.

THE HUB ANSWER CONTAINS THE ONE-TIME CALLBACK SECRET (callbackSecret) together with
callbackPath. It is printed once, on stdout, and never again: keep it out of rooms, logs and
message data, and hand it only to the job that will call back. A repeated --message-id
returns the stored row with duplicate: true and no secret.

Authentication is the bot key (--bot-key or PRIVOS_BOT_KEY); the hub refuses a human token.
Dry run unless --confirm.
`;

const agentsA2aCancelHelp = `Usage:
  privos agents a2a cancel --row ROW_ID [--bot-key KEY]

POST /api/v1/agents.a2a.await.cancel with {"rowId"}. Cancels an await that is still
waiting; the one-time URL stops working. Allowed for the bot that registered it, the chain's
accountable human or an administrator. Dry run unless --confirm.
`;

const agentsA2aMembersHelp = `Usage:
  privos agents a2a members --team TEAM_ID [--url URL] [--bot-key KEY]

GET /api/v1/agents.a2a.team.members?teamId=TEAM_ID. Prints the roster bots:
botId, username, runtime (sandbox or harness), and isMainBot.
`;

const agentsA2aChainHelp = `Usage:
  privos agents a2a chain --correlation C_ID [--count N] [--offset N] [--url URL] [--bot-key KEY]

GET /api/v1/agents.a2a.list?correlationId=C_ID. Prints every row of the chain:
kind, hop, sender, recipient, status, approval, and text.
`;

const agentsA2aStopHelp = `Usage:
  privos agents a2a stop --correlation C_ID [--team TEAM_ID] [--room ROOM_ID] [--text REASON]

Sends kind stop to the whole team on the chain through agents.a2a.send. Only the
chain initiator may stop it; anyone else gets a2a-stop-not-allowed. The team and
room are read from the chain with one GET unless you pass them. Dry run unless
--confirm.
`;

const hubInboxHelp = `Usage:
  privos hub inbox --since ISO|EPOCH_MS [--events dm,mention,message,notification]
                   [--rooms RID|NAME,...] [--exclude-bots] [--group-mentions]
                   [--include-text] [--priority-from USER,...] [--url URL]

One read-only poll for a cron routine: subscriptions.get?updatedSince, then
chat.syncMessages for each changed room, then in-app-notifications.list.
Prints one JSON event per line (the same envelope as privos subscribe --stdout)
and exits. The next cursor is printed on stderr as "cursor <ISO time>"; it
keeps a two-minute overlap, so dedupe events on id across runs.

Default --events is dm,mention,notification. Your own messages are always
skipped. Message text is left out unless --include-text is set.
Credentials come from the environment only (PRIVOS_HUB_URL, PRIVOS_USER_ID,
PRIVOS_PAT, or the PRIVOS_HUB_* names).
`;

const subscribeHelp = `Usage:
  privos subscribe [--events LIST] [--rooms RID|NAME,...] [--lists LIST_ID,...|all]
                   [--projects BOARD:PROJECT_ID,...] [--exclude-self] [--exclude-bots]
                   [--group-mentions] [--include-text] [--priority-from USER,...]
                   [--mode realtime|poll] [--state PATH]
                   [--stdout | --dry-run | --confirm]
                   [--webhook-url-env NAME] [--webhook-key-env NAME] [--webhook-header NAME]
  privos subscribe status [--state PATH]

A long-running, read-only watcher. It sends only GET requests to the hub and
boards, and on the hub websocket only DDP connect, login (resume token), and
sub. It never posts to PrivOS and never creates integrations.

Events (--events, default dm,mention,notification):
  dm            Direct messages
  mention       Messages that mention you, or replies in threads you follow
  message       Every message in your rooms (DMs and mentions keep their type)
  notification  In-app notifications (item assigned, stage changed, comments)
  item          List items created or changed (needs --lists; polled every 90 s)
  file          Room files created, changed, or deleted (every 5 min; all
                joined rooms unless --rooms is set)
  task          Board tasks (needs --projects; polled every 60 s)

Sources:
  --mode realtime (default) uses the hub websocket and polls every 5 min as a
  backstop. If the hub refuses the in-app notification feed, messages stay on
  the websocket and the hub is polled every 60 s instead. --mode poll polls the
  hub every 60 s. Board tasks are always polled. Lists and rooms are polled one
  at a time, at least 10 s (lists) or 15 s (rooms) apart, so a long --lists all
  or joined-room set takes longer than 90 s or 5 min to go round.
  After a reconnect or restart it reads back from the saved cursor minus 2 min.

Delivery:
  --stdout      One JSON event per line on stdout, no webhook
  (default)     Dry run: prints the webhook batches it would send
  --confirm     POST batches to the webhook: a 45 s coalescing window, at most
                4 POSTs a minute and 60 events a POST (the rest go into the
                digest counts). Events from --priority-from users skip the
                window. Naming yourself there does nothing: your own
                messages are never reported. Failed POSTs retry with backoff (2 s to 5 min); a 4xx
                other than 408, 413, or 429 stops the daemon with exit 1.

Filters: your own messages are always skipped, as are system messages.
--rooms limits messages, notifications, and files to those rooms; --lists
limits item events and item notifications. --lists all watches every list in
the rooms you belong to that the hub shows you (re-read every 15 min). Message text, item names, and file
names are left out unless --include-text is set (cut to 200 characters).

Environment:
  PRIVOS_HUB_URL, PRIVOS_USER_ID, PRIVOS_PAT     Hub (PRIVOS_HUB_* names also work)
  PRIVOS_SANDBOX_URL, PRIVOS_SANDBOX_API_KEY     Board "td" in --projects
  <BOARD>_URL, <BOARD>_API_ACCESS_KEY            Any other board alias, e.g.
                                                 TVIBE_URL, TVIBE_API_ACCESS_KEY
  GROK_MASTER_WEBHOOK_URL                        Webhook URL (--webhook-url-env renames it)
  GROK_MASTER_WEBHOOK_KEY                        Webhook key (--webhook-key-env renames it)
  GROK_MASTER_WEBHOOK_HEADER                     Header that carries the key

State: ~/.privos/subscribe/state.json (mode 0600; one daemon per file); a dry
run defaults to state.dry-run.json and --stdout to state.stdout.json, so they
do not use up the events of the --confirm daemon. It holds cursors, seen ids,
snapshots, and the outbox, which can include message text when --include-text
is set. A heartbeat is written every 30 s to "health" next to state.json, or
to NAME.health next to any other state file NAME.json; privos subscribe status
exits 1 when it is older than 10 min.
Logs carry ids and counts, never message text, keys, or the webhook URL.
`;

const subscribeStatusHelp = `Usage:
  privos subscribe status [--state PATH]

Prints the daemon heartbeat age, pid, mode, websocket state, whether
notifications come from the websocket or polling, cursors, lag, outbox size,
and counters as JSON. Pass --state for a --stdout or dry run
(~/.privos/subscribe/state.stdout.json, state.dry-run.json). Exits 1 when there is no heartbeat in the
last 10 minutes.
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
  "sandbox attempts": sandboxAttemptsHelp,
  "sandbox attempts cancel": sandboxAttemptsCancelHelp,
  "sandbox attempts stop": sandboxAttemptsCancelHelp,
  "sandbox attempts steer": sandboxAttemptsSteerHelp,
  "sandbox models": sandboxModelsHelp,
  "sandbox models list": sandboxModelsListHelp,
  hub: hubHelp,
  "hub get": hubGetHelp,
  "hub rooms": hubRoomsHelp,
  "hub rooms list": hubRoomsListHelp,
  "hub rooms create": hubRoomsCreateHelp,
  "hub rooms update": hubRoomsUpdateHelp,
  "hub rooms delete": hubRoomsDeleteHelp,
  "hub rooms members": hubRoomsMembersHelp,
  "hub rooms invite": hubRoomsInviteHelp,
  "hub rooms kick": hubRoomsKickHelp,
  "hub rooms archive": hubRoomsArchiveHelp,
  "hub dm": hubDmHelp,
  "hub dm reply": hubDmReplyHelp,
  "hub agents": hubAgentsHelp,
  "hub agents list": hubAgentsListHelp,
  "hub triggers": hubTriggersHelp,
  "hub triggers list": hubTriggersListHelp,
  "hub triggers get": hubTriggersGetHelp,
  "hub owner": hubOwnerHelp,
  "hub owner rooms": hubOwnerRoomsHelp,
  "hub owner messages": hubOwnerMessagesHelp,
  "hub messages": hubMessagesHelp,
  "hub messages list": hubMessagesListHelp,
  "hub messages send": hubMessagesSendHelp,
  "hub messages update": hubMessagesUpdateHelp,
  "hub messages delete": hubMessagesDeleteHelp,
  "hub files": hubFilesHelp,
  "hub files upload": hubFilesUploadHelp,
  "hub files folders": hubFilesFoldersHelp,
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
  "hub items attach": hubItemsAttachHelp,
  "hub items fields": hubItemsFieldsHelp,
  "hub items fields get": hubItemsFieldsHelp,
  "hub items fields set": hubItemsFieldsHelp,
  "hub items fields clear": hubItemsFieldsHelp,
  "hub stages": hubStagesHelp,
  "hub stages list": hubStagesListHelp,
  "hub stages create": hubStagesCreateHelp,
  "hub stages update": hubStagesUpdateHelp,
  "hub stages delete": hubStagesDeleteHelp,
  "hub fields": hubFieldsHelp,
  "hub fields list": hubFieldsListHelp,
  "hub fields get": hubFieldsGetHelp,
  "hub fields add": hubFieldsAddHelp,
  "hub fields update": hubFieldsUpdateHelp,
  "hub fields delete": hubFieldsDeleteHelp,
  "hub fields options": hubFieldOptionsHelp,
  "hub fields options add": hubFieldOptionsHelp,
  "hub fields options update": hubFieldOptionsHelp,
  "hub fields options delete": hubFieldOptionsHelp,
  "hub api": hubApiHelp,
  agents: agentsHelp,
  "agents a2a": agentsA2aHelp,
  "agents a2a send": agentsA2aSendHelp,
  "agents a2a members": agentsA2aMembersHelp,
  "agents a2a chain": agentsA2aChainHelp,
  "agents a2a stop": agentsA2aStopHelp,
  "agents a2a await": agentsA2aAwaitHelp,
  "agents a2a cancel": agentsA2aCancelHelp,
  "hub inbox": hubInboxHelp,
  subscribe: subscribeHelp,
  "subscribe status": subscribeStatusHelp,
  version: versionHelp,
};

export function helpFor(path: string[]): string {
  return HELP[path.join(" ")] ?? "";
}

export { rootHelp };
