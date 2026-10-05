# privos CLI

`privos` is a single operator CLI for a running PrivOS install. It talks to
two APIs:

- **sandbox** — the sandbox board (projects and tasks)
- **hub** — the PrivOS Hub (Rocket.Chat-derived rooms and messages, plus
  reserved list/item commands)

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

Requires Node.js 20 or newer. There are no runtime dependencies.

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
privos sandbox tasks update --id ID [--title T] [--description TEXT] [--status STATUS] [--position N] [--chat-init true|false]
privos sandbox tasks delete --id ID

privos hub rooms list [--updated-since RFC3339]
privos hub rooms create --name NAME [--kind channel|group] [--member USER] [--read-only] [--exclude-self]
privos hub rooms update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]
privos hub rooms delete --room ID [--kind channel|group]

privos hub messages list --room ROOM_ID [--kind channel|group|direct] [--count N] [--offset N]
privos hub messages send --room ROOM_ID --text TEXT
privos hub messages update --room ROOM_ID --id MSG_ID --text TEXT
privos hub messages delete --room ROOM_ID --id MSG_ID

privos hub lists list [--room ROOM_ID]      # reserved, no request
privos hub lists get --id LIST_ID           # reserved, no request
privos hub items list --list LIST_ID        # reserved, no request
privos hub items get --id ITEM_ID           # reserved, no request
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

`hub lists` and `hub items` accept their flags and exit 2 with a not-wired
message. They do not send HTTP. See [Hub API](../api/hub.md).

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
are not printed. stderr says that no request was sent. Exit code is 0.

`--confirm` sends those requests in order. A task update that changes both
text fields and status sends `PATCH /api/tasks/{id}` and then
`PUT /api/tasks/reorder`. A room update that sets both name and topic sends
rename, then `setTopic`.

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
```

The hub token is a personal access token, or the `authToken` from
`POST /api/v1/login`. This CLI does not ask for a password and does not call
login.

## Further reading

- [Sandbox board API](../api/sandbox.md)
- [Hub API](../api/hub.md)
