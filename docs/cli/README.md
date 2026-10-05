# privos CLI

`privos` is a single operator CLI for a running PrivOS install. It talks to
two APIs:

- **sandbox** — the sandbox board (projects and tasks)
- **hub** — the PrivOS Hub (Rocket.Chat-derived rooms, messages, and reserved
  list/item commands)

It does not install, upgrade, uninstall, or sign a release. `install.sh`,
`compose.yml`, and `publish-self-hosted-bundle.sh` are unchanged. The CLI is
not part of the minisign-signed install bundle.

This first slice is **read-only**. Every request is a GET. The HTTP client
refuses any other method unless a future command explicitly allows it, and it
does not follow redirects (so a credential header is not replayed onto another
host).

## Why Go

The installer in this repository is shell. The CLI is a small Go 1.22 program
that uses only the standard library, so it builds to one static binary and
does not need Node or Python on the host. Build it when you want it; the
installer does not.

Requires Go 1.22 or newer.

```bash
# from the repository root
go build -C cli -o privos ./cmd/privos
./privos --help
./privos version
```

Run the tests (they use a local mock server and do not call a live API):

```bash
go test -C cli ./...
```

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
| `--format json\|table` | Default `json`. `table` is a plain-text view of the list. |
| `--raw` | Print the response body unchanged. |
| `--timeout SECONDS` | HTTP timeout, 1–300. Default 30. |
| `--help`, `-h` | Help for the current command. |

Exit codes: `0` success, `2` usage or missing config, `1` the request failed
or the response could not be shown.

## Commands

```text
privos sandbox projects list
privos sandbox tasks list [--project ID] [--status STATUS] [--limit N] [--after CURSOR]
privos hub rooms list [--updated-since RFC3339]
privos hub messages list --room ROOM_ID [--kind channel|group|direct] [--count N] [--offset N]
privos hub lists list [--room ROOM_ID]      # reserved, no request
privos hub lists get --id LIST_ID           # reserved, no request
privos hub items list --list LIST_ID        # reserved, no request
privos hub items get --id ITEM_ID           # reserved, no request
```

`--project` may be repeated. Task status values the board UI uses include
`todo`, `in_progress`, `in_review`, `done`, and `cancelled`. Other values are
passed through.

Room type `t` from `hub rooms list` selects `--kind`:

| `t` | `--kind` | Endpoint |
|---|---|---|
| `c` | `channel` (default) | `GET /api/v1/channels.messages` |
| `p` | `group` | `GET /api/v1/groups.messages` |
| `d` | `direct` | `GET /api/v1/im.messages` |

`hub lists` and `hub items` accept their flags and exit 2 with a not-wired
message. They do not send HTTP. See [Hub API](../api/hub.md).

## Examples

```bash
export PRIVOS_SANDBOX_URL=http://127.0.0.1:8556
export PRIVOS_SANDBOX_API_KEY='your-sandbox-api-key'
./privos sandbox projects list
./privos sandbox tasks list --project PROJECT_ID --status todo --format table

export PRIVOS_HUB_URL=http://127.0.0.1:3000
export PRIVOS_HUB_USER_ID='your-user-id'
export PRIVOS_HUB_AUTH_TOKEN='your-auth-token'
./privos hub rooms list
./privos hub messages list --room ROOM_ID --kind channel
```

The hub token is a personal access token, or the `authToken` from
`POST /api/v1/login`. This CLI does not ask for a password and does not call
login.

## Writes

No write command is implemented. When one is added it must:

1. Default to a dry run that prints the method and path and sends nothing.
2. Send the request only when `--confirm` is present.
3. Stay out of CI. Tests keep using a local mock server.

The client already rejects POST, PUT, PATCH, and DELETE.

## Further reading

- [Sandbox board API](../api/sandbox.md)
- [Hub API](../api/hub.md)
