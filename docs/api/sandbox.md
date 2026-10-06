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

There is also `GET /api/tasks/{id}` for one task. `tasks start` and
`tasks answer` read it to get `projectId` and the description.

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

## Start an agent on a task

The board UI starts an agent with up to three writes. `privos sandbox tasks
start` sends the same ones, after two reads.

| Step | Request | When |
|---|---|---|
| Read the task | `GET /api/tasks/{id}` | always (also in a dry run) |
| Read its attempts | `GET /api/tasks/{id}/attempts` | always (also in a dry run) |
| Move the card | `PUT /api/tasks/reorder` body `{"taskId","status":"in_progress","position":-Date.now()}` | task status is not `in_progress` |
| Open the chat | `PATCH /api/tasks/{id}` body `{"chatInit":true}` | `chatInit` is not true |
| Create the attempt | `POST /api/attempts` with `x-project-id` | always |

`POST /api/attempts` body:

| Field | Required | Notes |
|---|---|---|
| `taskId` | yes | HTTP 400 without it |
| `prompt` | yes | HTTP 400 without it. The CLI defaults to the task description. |
| `projectId` | yes | from the task |
| `model` | no | model id |
| `provider` | no | `claude-cli`, `claude-sdk`, `privos-agent-sdk`, `codex-cli`, `antigravity-cli`. The UI sends it for built-in catalog rows. |
| `llmProviderId` | no | sent instead of `provider` for custom catalog rows |
| `effort` | no | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Passed to the runtime (claude-cli adds `--effort`), not validated and not stored on the attempt. |

The response is HTTP 201 with the attempt. The board moves a `todo` task to
`in_progress` itself, but not a task in `in_review` or `done`, which is why the
reorder step stays. The board does not stop a second attempt on a task that
already has one running; the CLI refuses unless `--force` is passed.

`privos sandbox tasks create --start` creates the task with
`"status":"in_progress"`, then sends the `PATCH` and `POST /api/attempts`
with the new task id.

## Read attempts, conversation and pending questions

| Request | Response | CLI |
|---|---|---|
| `GET /api/tasks/{id}/attempts` | `{"attempts":[{id,status,model,provider,createdAt,...}]}`. A pure read. | `tasks attempts --id ID` |
| `GET /api/tasks/{id}/conversation?limit=&before=` | one page of the conversation | `tasks conversation --id ID [--limit N] [--before MS]` |
| `GET /api/tasks/{id}/running-attempt` | `{"attempt":null\|{id,prompt,status,hidden},"messages":[...],"backgroundShells":[...]}` | `tasks running --id ID` |
| `GET /api/tasks/{id}/pending-question` | `{"question":null\|{attemptId,toolUseId,questions:[{question,header,options:[{label,description}],multiSelect}]}}`. A pure read. | `tasks question --id ID` |

`running-attempt` has side effects. It marks running attempts older than
24 hours as failed, and it moves an `in_progress` task with no running attempt
to `in_review`.

`effort` reads as `null` on attempts because the board never stores it.

## Answer a pending question

The board UI answers over socket.io, not REST. The server is socket.io 4.8 on
the same host and port as the HTTP API, at the default path `/socket.io/`.

- Auth: handshake `auth: { token: <API key> }`. A wrong key fails the
  connection with `Unauthorized: valid API key required`. With no
  `API_ACCESS_KEY` set on the board, auth is off.
- Event: `question:answer` with payload
  `{"attemptId","projectId","toolUseId","questions","answers"}`. `answers`
  maps each question's `question` text to the answer.
- Ack: the plain board acks `{"success":true}` or
  `{"success":false,"error","code"}`. A repeat of the same answer within
  30 seconds is acked without being applied again. In sandbox mode the board
  forwards the event without an ack (and reports a missing `projectId` with an
  `error` event).
- A delivered answer clears the question, so `pending-question` then returns
  `null` or a question with another `toolUseId`.

`POST /api/attempts/{id}/answer` with `{"projectId","toolUseId","questions","answers"}`
also exists, but it requires a `workspaceId` in the body equal to the
attempt's, and answers HTTP 400 without one. Attempts created by the board or
the CLI have no `workspaceId`, and neither the board UI nor the CLI sends one,
so the call fails today. `POST /api/attempts/{id}/cancel` fails the same way. `privos sandbox tasks
answer` sends the socket event first and then this REST call as a best-effort
answer log, ignoring its errors.

## List models

`GET /api/models`

Response:
`{"models":[{id,name,provider,providerName,runtimeProvider,llmProviderId?,supportedEffortLevels?}],"current","currentProvider","selection","source"}`.

`runtimeProvider` is the value for `provider` on `POST /api/attempts`. A row
with `llmProviderId` is a custom catalog model: send `llmProviderId` and
`model` instead. `supportedEffortLevels` is missing on many built-in rows,
because the board UI works those out itself.

```text
privos sandbox models list --format table
```
