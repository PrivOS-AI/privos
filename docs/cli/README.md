# privos CLI

`privos` is a single operator CLI for a running PrivOS install. It talks to
two APIs:

- **sandbox** — the sandbox board (projects and tasks)
- **hub** — the PrivOS Hub (Rocket.Chat-derived rooms and messages, plus
  lists and items)

It does not install, upgrade, uninstall, or sign a release. `install.sh`,
`compose.yml`, and `publish-self-hosted-bundle.sh` are unchanged. The CLI is
not part of the minisign-signed install bundle.

## Install

The CLI is a Node package. The command name is `privos`.

```bash
npm install -g @privos_ai/privos
privos --help

# or, without a global install
npx @privos_ai/privos --help
```

From a checkout of this repository:

```bash
cd cli
npm install
npm test
npm run build
node dist/main.js --help
```

`npm pack` (run from `cli/`) produces the tarball. This repository does not
publish that tarball.

The package name is `@privos_ai/privos`. That is the npm org already used by
`@privos_ai/app-server`, `@privos_ai/app-cluster`, and
`@privos_ai/privos-agent-sdk`. The unscoped name `privos` and the scope
`@privos-ai` are not the published org.

Requires Node.js 20 or newer. The only runtime dependency is socket.io-client,
used by `tasks answer`.

### Why this is not the Go binary

The first CLI (0.1.0) was a Go 1.22 program. An npm wrapper around that binary
would still need a multi-platform build and a place to download it from, and
this repository's signed release bundle must not grow a download step. The Go
tree is removed in this version so there is one implementation: the Node
package users run with `npx` or `npm install`.

## Configuration

Flags override environment variables. Empty variables are ignored. Prefer
environment variables for keys and tokens so they are not copied into the
process list. Do not put credentials in the URL.

| Target | Flag | Environment | Sent as |
|---|---|---|---|
| Sandbox base URL | `--url` | `PRIVOS_SANDBOX_URL` | request URL |
| Sandbox API key | `--api-key` | `PRIVOS_SANDBOX_API_KEY`, then `API_ACCESS_KEY`, then `SANDBOX_API_KEY` | `x-api-key` |
| Hub base URL | `--url` | `PRIVOS_HUB_URL`, then `PRIVOS_ROOT_URL` | request URL |
| Hub user id | `--user-id` | `PRIVOS_HUB_USER_ID` | `X-User-Id` |
| Hub auth token | `--auth-token` | `PRIVOS_HUB_AUTH_TOKEN` | `X-Auth-Token` |

`API_ACCESS_KEY` is the name the board container uses. `SANDBOX_API_KEY` is
the name `install.sh` writes into the stack `.env`. `PRIVOS_ROOT_URL` is the
public hub URL the installer already records.

On a default self-hosted install the board listens on `http://127.0.0.1:8556`
and the hub on `http://127.0.0.1:3000` (see `PRIVOS_BOARD_PORT` and
`PRIVOS_HUB_PORT`). The CLI does not read `/opt/privos/.env` by itself.

Shared flags:

| Flag | Meaning |
|---|---|
| `--format json\|table` | Default `json`. `table` is a plain-text view of a list read. Writes always print JSON. |
| `--raw` | Print a live response body unchanged. |
| `--timeout SECONDS` | HTTP timeout, 1–300. Default 30. |
| `--confirm` | Send a write. Required for every mutating command. |
| `--dry-run` | Print the write and send nothing. This is the default. Cannot be combined with `--confirm`. |
| `--help`, `-h` | Help for the current command. |

Exit codes: `0` success (including a dry run), `2` usage or missing config,
`1` the request failed or the response could not be shown.

The HTTP client does not follow redirects, so a credential header is not
replayed onto another host. Errors print the HTTP status and a message from
the JSON body. They do not print the API key or the hub token.

## Commands

```text
privos sandbox projects list
privos sandbox projects create --name NAME --path ABS_PATH [--hook-template]
privos sandbox projects create --sandbox --name NAME [--auto-start] [--hook-template]
privos sandbox projects update --id ID [--name NAME] [--autopilot off|autonomous]
privos sandbox projects delete --id ID
privos sandbox projects start --id ID

privos sandbox tasks list [--project ID] [--status STATUS] [--limit N] [--after CURSOR]
privos sandbox tasks create --project ID --title TITLE [--description TEXT] [--status STATUS]
privos sandbox tasks create --project ID --title TITLE --description TEXT --start [--model M] [--provider P | --llm-provider ID] [--effort E]
privos sandbox tasks update --id ID [--title T] [--description TEXT] [--status STATUS] [--position N] [--chat-init true|false]
privos sandbox tasks delete --id ID
privos sandbox tasks start --id ID [--model M] [--provider P | --llm-provider ID] [--effort E] [--prompt TEXT] [--force]
privos sandbox tasks attempts --id ID
privos sandbox tasks conversation --id ID [--limit N] [--before MS]
privos sandbox tasks running --id ID
privos sandbox tasks question --id ID
privos sandbox tasks answer --id ID --answer TEXT [--answer TEXT ...]

privos sandbox models list

privos hub rooms list [--updated-since RFC3339]
privos hub rooms create --name NAME [--kind channel|group] [--member USER] [--read-only] [--exclude-self]
privos hub rooms update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]
privos hub rooms delete --room ID [--kind channel|group]

privos hub messages list --room ROOM_ID [--kind channel|group|direct] [--count N] [--offset N]
privos hub messages send --room ROOM_ID --text TEXT
privos hub messages update --room ROOM_ID --id MSG_ID --text TEXT
privos hub messages delete --room ROOM_ID --id MSG_ID

privos hub lists list [--room ROOM_ID]
privos hub lists get --id LIST_ID
privos hub lists create --room ROOM_ID [--name NAME] [--description TEXT] [--field-definitions JSON] [--cross-team true|false] [--isolated true|false]
privos hub lists update --id LIST_ID [--name NAME] [--description TEXT] [--room ROOM_ID] [--cross-team true|false] [--isolated true|false]
privos hub lists delete --id LIST_ID

privos hub items list --list LIST_ID [--include-sub-items]
privos hub items list --list LIST_ID [--stage STAGE_ID] [--parent ITEM_ID] [--count N] [--offset N] [--sort SORT] [--after CURSOR]
privos hub items list --stage STAGE_ID
privos hub items list --parent ITEM_ID
privos hub items get --id ITEM_ID
privos hub items search --list LIST_ID --term TEXT
privos hub items find --list LIST_ID --field FIELD_ID --value VALUE
privos hub items create --list LIST_ID --stage STAGE_ID [--name NAME] [--description TEXT] [--parent ITEM_ID] [--custom-fields JSON]
privos hub items update --id ITEM_ID [--name NAME] [--description TEXT] [--stage STAGE_ID] [--custom-fields JSON] [--archived true|false] [--order N] [--show-archived-sub-items true|false]
privos hub items delete --id ITEM_ID
privos hub items move --id ITEM_ID --stage STAGE_ID
privos hub items reorder --id ITEM_ID --order N
```

`--project` may be repeated on `tasks list`. Task create takes exactly one
`--project`. Task status values the board UI uses include `todo`,
`in_progress`, `in_review`, `done`, and `cancelled`. Other values are passed
through.

Room type `t` from `hub rooms list` selects `--kind` for message reads and
for room writes that differ by room type:

| `t` | `--kind` | Message read | Room create / delete / rename / topic |
|---|---|---|---|
| `c` | `channel` (default) | `GET /api/v1/channels.messages` | `channels.create`, `channels.delete`, `channels.rename`, `channels.setTopic` |
| `p` | `group` | `GET /api/v1/groups.messages` | `groups.create`, `groups.delete`, `groups.rename`, `groups.setTopic` |
| `d` | `direct` | `GET /api/v1/im.messages` | not a write target |

`hub messages send`, `update`, and `delete` use `chat.sendMessage`,
`chat.update`, and `chat.delete`. Those take a room id, so they do not use
`--kind`.

List and item reads are `GET /api/v1/lists.*` and `GET /api/v1/items.*`.
List and item writes are `POST` and stay a dry run until `--confirm`.
`lists.create` sends `fieldDefinitions: []` unless `--field-definitions` is
a JSON array, and its response includes `defaultStage` for
`hub items create --stage`. Field CRUD (`lists.addField`, `lists.fields.*`),
`items.bulkUpdateOrder`, and `stages.*` are not commands. The CLI does not
call `/api/v1/bot/lists` or MCP `privos.lists.*`. See [Hub API](../api/hub.md).

## Writes

Every mutating command is a dry run unless `--confirm` is present.

A dry run prints JSON to stdout:

```json
{
  "dryRun": true,
  "requests": [
    {
      "method": "POST",
      "url": "http://127.0.0.1:8556/api/projects",
      "headers": { "content-type": "application/json" },
      "omittedHeaderNames": ["x-api-key"],
      "body": { "name": "Alpha", "path": "/work/alpha", "useHookTemplate": false }
    }
  ]
}
```

Credential header names are listed under `omittedHeaderNames`. Their values
are not printed. stderr says that no write was sent. Exit code is 0.
`tasks start` and `tasks answer` still send their `GET` reads in a dry run,
so the preview holds real values.

`--confirm` sends those requests in order. A task update that changes both
text fields and status sends `PATCH /api/tasks/{id}` and then
`PUT /api/tasks/reorder`. A room update that sets both name and topic sends
rename, then `setTopic`. If a later request fails, stdout shows
`{"results": [...], "failed": {...}}` with the responses of the requests
that already went through, and the exit code is 1.

## Starting an agent

`tasks start` starts an agent on a task the way the board UI does. It first
reads `GET /api/tasks/{id}` and `GET /api/tasks/{id}/attempts`. These two
reads are sent even in a dry run. Then, with `--confirm`, it sends:

1. `PUT /api/tasks/reorder` with `status: "in_progress"`, only when the task
   is not already `in_progress`.
2. `PATCH /api/tasks/{id}` with `{"chatInit":true}`, only when `chatInit` is
   not already true.
3. `POST /api/attempts` with `{"taskId","prompt","projectId"}` plus the model
   fields, and the `x-project-id` header.

The prompt is the task description unless `--prompt` is set. `--model` and
`--provider` (or `--llm-provider` with `--model` for a custom catalog model)
pick the runtime; `privos sandbox models list` shows the choices. A task that
has never run should get both, or the board uses its default.

`--effort` takes `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. `ultra`
only matters to Claude runtimes. The board passes effort to the runtime and
does not store it, so attempt reads show `"effort": null`.

`start` refuses while an attempt created in the last 24 hours is still
running, because the board would run a second agent on the same task.
`--force` starts anyway and prints a warning.

`tasks create --start` creates the task in `in_progress` and starts it in the
same command: `POST /api/tasks`, `PATCH /api/tasks/{new id}`, then
`POST /api/attempts`. `--description` is required and becomes the prompt. The
dry run shows `{taskId from response 1}` where the new id goes.

To follow a run:

- `tasks attempts` lists attempts. It is a pure read.
- `tasks conversation` reads one page of the conversation.
- `tasks running` reads the running attempt. The board also cleans up on this
  call: it fails running attempts older than 24 hours and moves an
  `in_progress` task with no running attempt to `in_review`. Use
  `tasks attempts` when you only want to look.
- `tasks question` reads the question the agent is waiting on.

`tasks answer` answers that question over socket.io, as the board UI does: it
emits `question:answer` with the API key as the handshake `auth.token`. Pass
one `--answer` per question, in the order `tasks question` prints them. The
answer counts as delivered when the board acks it, or, when no ack comes
(sandbox mode), once a re-read shows the question gone. The CLI then also
sends `POST /api/attempts/{id}/answer` to save the answer log. The REST answer
route only accepts hub attempts that carry a `workspaceId`, so for board
attempts this call fails; the error is printed and ignored. `tasks cancel` is
not available for the same reason.

```bash
privos sandbox models list --format table
privos sandbox tasks start --id TASK_ID --model claude-opus-5-5 --provider claude-cli --effort high
privos sandbox tasks start --id TASK_ID --model claude-opus-5-5 --provider claude-cli --effort high --confirm
privos sandbox tasks question --id TASK_ID
privos sandbox tasks answer --id TASK_ID --answer 'Postgres' --confirm
```

Do not point CI at a live board or hub. The tests use a local mock server.

## Examples

```bash
export PRIVOS_SANDBOX_URL=http://127.0.0.1:8556
export PRIVOS_SANDBOX_API_KEY='your-sandbox-api-key'
privos sandbox projects list
privos sandbox tasks list --project PROJECT_ID --status todo --format table

# prints the POST and does not send it
privos sandbox tasks create --project PROJECT_ID --title 'Write the notes'
# sends it
privos sandbox tasks create --project PROJECT_ID --title 'Write the notes' --confirm
privos sandbox tasks update --id TASK_ID --status in_progress --confirm

export PRIVOS_HUB_URL=http://127.0.0.1:3000
export PRIVOS_HUB_USER_ID='your-user-id'
export PRIVOS_HUB_AUTH_TOKEN='your-auth-token'
privos hub rooms list
privos hub messages list --room ROOM_ID --kind channel
privos hub messages send --room ROOM_ID --text 'hello' --confirm
privos hub lists list --room ROOM_ID
privos hub lists create --room ROOM_ID --name Tasks --confirm
privos hub items create --list LIST_ID --stage STAGE_ID --name Draft --confirm
privos hub items move --id ITEM_ID --stage STAGE_ID --confirm
```

The hub token is a personal access token, or the `authToken` from
`POST /api/v1/login`. This CLI does not ask for a password and does not call
login.

## Further reading

- [Sandbox board API](../api/sandbox.md)
- [Hub API](../api/hub.md)
