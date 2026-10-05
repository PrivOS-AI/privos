# Sandbox board API

The sandbox board is the Next.js service in the `sandbox-board` container.
On a default self-hosted install it listens on `http://127.0.0.1:8556`
(`PRIVOS_BOARD_PORT`). A hosted board looks like `https://tvibe.roxane.one`.

Health for the container is `GET /api/bot/health` (no API key). The CLI does
not use that path.

Write paths below are the ones the board's own client sends, taken from the
hosted board bundle (`tvibe.roxane.one`, deploy
`dev-f9be3149f53e-20260930T100503Z`). Self-hosted compose sets
`PRIVOS_SANDBOX_MODE=true` on `sandbox-board`. In that bundle,
`isClientSandboxMode()` is compiled to `false`, and the setup dialog then
uses `POST /api/projects`. The same dialog uses `POST /api/sandbox/projects`
when client sandbox mode is on. The CLI exposes both and does not guess which
one a given board was built with.

## Auth

Send the board access key in the `x-api-key` header. That value is
`API_ACCESS_KEY` inside the board container, which `install.sh` fills from
`SANDBOX_API_KEY`.

```bash
curl -sS -H "x-api-key: $PRIVOS_SANDBOX_API_KEY" \
  "$PRIVOS_SANDBOX_URL/api/projects"
```

A missing or wrong key returns HTTP 401:

```json
{"error":"Unauthorized","message":"Valid API key required"}
```

The CLI accepts the key from `--api-key`, then `PRIVOS_SANDBOX_API_KEY`,
then `API_ACCESS_KEY`, then `SANDBOX_API_KEY`.

Task create also sends `x-project-id` with the project id. That header is
what `POST /api/tasks` sets in the board client.

## List projects

`GET /api/projects`

Response: a JSON array. Each object has at least `id` and `name`.

```text
privos sandbox projects list
```

## Create, update, delete, start a project

| Action | Request | CLI |
|---|---|---|
| Create (client sandbox mode off) | `POST /api/projects` body `{"name","path","useHookTemplate"}` | `projects create --name NAME --path ABS_PATH` |
| Create (client sandbox mode on) | `POST /api/sandbox/projects` body `{"projectName","autoStart","useHookTemplate"}` | `projects create --sandbox --name NAME` |
| Rename or autopilot | `PATCH /api/projects/{id}` body `{"name"}` and/or `{"autopilotMode":"off"\|"autonomous"}` | `projects update --id ID` |
| Delete | `DELETE /api/projects/{id}` | `projects delete --id ID` |
| Start a sandbox project | `POST /api/sandbox/projects/{id}/start` with no body | `projects start --id ID` |

`path` is an absolute filesystem path. The setup dialog refuses anything else.
`useHookTemplate` defaults to false. `--hook-template` sets it true.
`--auto-start` sets `autoStart` true and is only valid with `--sandbox`. The
board UI also calls the start route after a sandbox-mode create; that second
call is `projects start`, not implied by create.

Every one of these is a dry run until `--confirm`.

## List tasks

`GET /api/tasks`

Query parameters the board's own client sends, and that `privos` sends when
the matching flag is set:

| Query | CLI | Meaning |
|---|---|---|
| `projectIds` | `--project` (repeatable) | Comma-separated project ids. Omitted means no project filter. |
| `status` | `--status` | One status, for example `todo`, `in_progress`, `in_review`, `done`, `cancelled`. |
| `limit` | `--limit` | Page size. |
| `after` | `--after` | Cursor `position,updatedAt,id`. |
| `ids` | — | Not exposed. The board client can request tasks by id. |

Response: a JSON array. Fields the CLI table prints: `id`, `title`,
`status`, `projectId`.

```text
privos sandbox tasks list --project PROJECT_ID --status todo
```

There is also `GET /api/tasks/{id}` for one task. The CLI does not call it yet.

## Create, update, delete a task

| Action | Request | CLI |
|---|---|---|
| Create | `POST /api/tasks` with `x-project-id` and body `{"projectId","title"}` plus optional `description` and `status` | `tasks create --project ID --title TITLE` |
| Title, description, chat init | `PATCH /api/tasks/{id}` with `{"title"}`, `{"description"}`, and/or `{"chatInit":true\|false}` | `tasks update --id ID --title … --description … --chat-init true\|false` |
| Status move | `PUT /api/tasks/reorder` body `{"taskId","status","position"}` | `tasks update --id ID --status STATUS [--position N]` |
| Delete | `DELETE /api/tasks/{id}` | `tasks delete --id ID` |

The board client moves a card with `PUT /api/tasks/reorder`, not with
`PATCH`. When `--position` is omitted, the CLI sends `position` as
`-Date.now()`, which is the value that client uses on a status change.
A title change and a status change in one command are two requests: `PATCH`,
then `PUT`.

These commands are a dry run until `--confirm`. Tests mock HTTP. They do not
call a live board.
