# Changelog

All notable changes to `@privos_ai/privos`. Full command notes live in
[docs/cli/README.md](https://github.com/PrivOS-AI/privos/blob/main/docs/cli/README.md).

## Unreleased

### Added

- `privos hub lists create --stages` names the list's stages, as comma-separated names or
  a JSON array of names or `{name, color}`. A stage without a color gets one from its name
  (gray inbox or to do, blue doing, orange waiting, purple review, green done, red blocked
  or cancelled). Bot mode sends them in the room route's `stages`; a personal token renames
  the default "Ungroup" stage to the first one and creates the rest with `stages.create`.

## 0.12.0 — 2026-10-22

### Added

- `privos sandbox attempts cancel|stop|steer --id ATTEMPT_ID` stops a running attempt or
  sends it a message. Both read the attempt's ids from `GET /api/attempts/ID/status`
  (falling back to the full attempt on an older board), send `x-project-id`, and print the
  board's reply. `cancel` exits 0 when the attempt is no longer running (`cancelled` or
  `replayed`); `steer` exits 0 only for `outcome: "accepted"`. `steer` refuses, before
  posting, an attempt that waits for an answer and prints the `tasks answer` command.

### Changed

- `tasks answer` sends `POST /api/attempts/ID/answer` first and treats HTTP 200 as
  delivered. The workspace id is sent only when the attempt or its task has one; when it came
  from the task and the board answers 404 `Attempt not found`, the post is retried once
  without it (an older board then answers its legacy 400). The socket `question:answer`
  event is used only when an older board answers its legacy 400 or the board answers 404 for
  a stored question with no live agent, after a re-read confirms the same question (and, for
  the 404, the attempt's live question has no different id). Output is now `{answered, attemptId, toolUseId, via, confirmedBy}`; the
  `restLog` field is removed.
- `tasks answer` refuses a question that asks for a secret (any item with a `credential`
  marker, the vault form) with exit 2, before printing or sending anything.
- The socket connection uses the websocket transport only, and a connect error names the
  transport and the URL.
- `tasks start` reuses the task's previous runtime per field: the newest attempt with a
  provider (provider, model, custom provider id), else the task's last provider and model,
  else `claude-cli`. Explicit flags always win. `tasks create --start` sends `claude-cli`
  unless `--provider` or `--llm-provider` is given.
- `PUT /api/tasks/reorder` (from `tasks start` and `tasks update --status`) carries
  `x-project-id`; `tasks update --status` reads the task first to learn its project.

### Fixed

- `tasks answer` could not reach a board that accepts websocket handshakes only (it failed
  with `xhr poll error`).
- A test now pins the process exit code (1 for a failed command, 2 for a usage error).

## 0.11.0 — 2026-10-19

### Added

- `privos hub messages send --room ROOM_ID --file PATH [--text TEXT]` posts a local file
  (image, video, audio, document, any type) as a chat attachment with one multipart
  `POST /api/v1/rooms.upload/ROOM_ID`; `--text` becomes its message.
- `privos hub files upload --room ROOM_ID --file PATH [--folder FOLDER_ID]
  [--duplicate replace|keep_both|cancel]` uploads a file to the room's File Management
  (`file-management.files.upload`), and `privos hub files folders --room ROOM_ID
  [--parent FOLDER_ID]` lists its folders.
- `privos hub items attach --room ROOM_ID --id ITEM_ID --field FIELD_ID --file PATH`
  uploads a file into the item folder `Uploads/list-items/ITEM_ID` (created when missing)
  and sets it on a `FILE`, `FILE_MULTIPLE` or `DOCUMENT` field through the single-field
  room route, so no other field changes. A `FILE` field is replaced; the others get the
  file appended.
- The content type comes from the file extension. Dry runs print the file's name, type
  and size, never its bytes.

### Changed

- `hub messages` and `hub files` use the sandbox egress in an agent VM, like the other
  bot commands. A binary body travels base64-encoded with `x-content-encoding: base64`.

## 0.10.0 — 2026-10-16

### Added

- `privos agents a2a await` registers a one-time callback wake in a chain (bot key;
  dry run unless `--confirm`): `--correlation`, `--room`, `--deadline-at`, `--text`,
  optional `--team`, `--reply-to`, `--message-id` and `--match-event` with
  `--match-room`. The hub answer carries the one-time callback path and secret; it
  is printed once on stdout. `privos agents a2a cancel --row ROW_ID` cancels it.
- `privos sandbox tasks create --callback-url-env NAME --callback-key-env NAME`
  passes an await's callback to the board task. Values come from the environment
  only; the dry run shows the URL host and `secret: "<set>"`.

### Changed

- In bot mode `privos hub triggers list --agent BOT_ID` now sends the request for
  a peer and lets the hub decide (same owner or shared agent team). A peer answer
  is a reduced view without prompt text, with a note on stderr; when the peer's
  owner must approve, the hub's refusal is followed by a hint to use
  `needs-approval --action trigger-read`. `--all` stays refused in bot mode.
- Needs the hub release that carries the peer-read rule and the await routes.

## 0.9.0 — 2026-10-16

### Added

- `privos hub agents list`: the agents you created (id, username, name, runtime,
  agent room, super agent flag). Personal token only; a bot key is told to use
  `privos agents a2a members` instead.
- `privos hub triggers list [--agent ID|USERNAME|AGENT_ROOM_ID | --all]` and
  `privos hub triggers get --id TRIGGER_ID`: read the cron, event and webhook
  triggers of your agents as JSON (`{ triggers, total, errors? }`) or as a table.
  Every row carries a `kind` label (`llm`, `no-llm` or `handler`). Reads send
  `GET` only and need no `--confirm`.
- Bot mode (bot key or sandbox egress) reads the agent's own triggers only. A
  super agent reads them from a session in its own agent room over the egress;
  another agent's triggers are refused until the hub's peer-read rule ships.

### Changed

- A webhook trigger's `webhookToken` is never printed; rows show `hasWebhook`
  and `webhookTokenFingerprint` (first 8 hex of its SHA-256) instead.
- Table output strips terminal control characters and direction overrides from
  every cell.

## 0.8.0 — 2026-10-11

### Added

- `privos hub owner rooms` and `privos hub owner messages --room RID
  [--count N] [--offset N] [--oldest ISO] [--latest ISO]`: a super agent reads
  its owner's one-to-one DMs, the owner's Inbox and the owner's DM with the
  Universal Assistant without joining them. Only inside an agent VM, over the
  sandbox egress; a personal token or a bare bot key is refused before any
  request. The hub audits every read.

### Changed

- `privos hub dm reply` also accepts the owner's Inbox and the owner's DM with
  the Universal Assistant. A message there asks the Universal Assistant in the
  owner's name; read its answer with `privos hub owner messages`.

## 0.7.0 — 2026-10-09

### Added

- Bot mode for `privos hub lists` and `privos hub items`: with a bot key
  (`--bot-key`, `PRIVOS_BOT_KEY`) or the sandbox egress they call the room
  routes `/api/v1/internal/rooms/ROOM_ID/...`, because bot keys cannot use the
  public `lists.*` and `items.*` routes. `--room` is required (default
  `PRIVOS_ROOM_ID`) and `items create` and `lists create` need `--name`. Flags the
  room routes would drop silently and the commands `items search|find|reorder`
  are refused with a usage error. `lists get` and `items get` print the same
  shape as personal-token mode.
- Sandbox egress: inside an agent VM (`PRIVOS_SANDBOX_MODE=true`, `PROXY_URL`,
  `PROXY_TOKEN`) with no credential of your own, `hub rooms|lists|items|dm` and
  `agents a2a` send every request through `POST $PROXY_URL/egress`. The VM never
  holds the bot key; the proxy attaches it. The hub is `--url`, else
  `PRIVOS_HUB_URL`, else `https://$PRIVOS_HUB_HOST`. The proxy's error `code`
  prints first (`no-binding`, `ssrf-denied`). `hub get`, `subscribe` and
  `sandbox tasks answer` refuse the egress with a clear message when they have
  no connection of their own.
- `privos hub rooms members|invite|kick|archive`: room management for an agent
  bot (`--member` is a user id; `--kind channel|group` as on `update`). Rename
  is `hub rooms update --name`. Over the egress, `update --topic` and `delete`
  are refused because the proxy does not open those routes.
- `privos hub dm reply --room DM_ROOM_ID --text TEXT`: asks the PrivOS Hub to
  answer the owner's one-to-one DM in the owner's name. Egress only. Prints the
  hub's `status`: `drafted` (the owner must press Send in the agent room) or
  `sent`.

### Fixed

- The `hub lists` help said lists use user headers only; they accept a bot key
  and the egress too.

## 0.6.0 — 2026-10-08

### Added

- `privos hub get --route ROUTE [--param key=value ...]`: reads any hub GET
  route with your own `X-User-Id` and `X-Auth-Token` and prints the JSON body.
  There is no client-side route list, so new hub routes work without a CLI
  release. Bot keys are refused (`--bot-key` and `PRIVOS_BOT_KEY` do not apply)
  and `--format table` is not supported. The hub's own permission check
  decides; its refusal prints as `HTTP 403: <error>`.
- `--requester ID`, `--requester-name NAME` and `--requester-kind human|agent`
  (env `PRIVOS_REQUESTER_ID`, `PRIVOS_REQUESTER_NAME`, `PRIVOS_REQUESTER_KIND`)
  on board writes: sent as `x-privos-requester-id|name|kind` headers on every
  board request and as `auth.requester` on the answer socket, so the board
  records who started or answered an attempt. `tasks attempts` shows the
  requester. The claim is self-declared unless the board binds the key to an
  identity.

## 0.5.0 — 2026-10-06

### Added

- `privos agents a2a send|members|chain|stop`: the bot-to-bot protocol of the
  hub (`agents.a2a.*`) from outside the sandbox. `send` builds the envelope and
  generates the idempotent `messageId`; `stop` sends `kind: stop` for a chain
  you started. Pair it with `privos subscribe` to watch the results.
- `--bot-key` / `PRIVOS_BOT_KEY` for the `hub` and `agents` commands: sends
  `Authorization: Bearer` and no `X-User-Id` or `X-Auth-Token`. Agent bots cannot
  mint personal access tokens. `privos subscribe` and `hub inbox` still need a
  human token.
- A hub refusal that carries an `errorType` (the a2a codes) prints it first:
  `HTTP 403: a2a-sender-ineligible: ...`.

## 0.4.1 — 2026-10-06

### Fixed

- `privos subscribe`: when the hub refuses the `in_app_notifications.updates`
  websocket subscription (roxane answers it with error 500), the daemon now
  logs it, keeps the message stream live, and polls notifications every
  60 seconds instead of reconnecting forever and falling back to the 5-minute
  backstop. `privos subscribe status` shows `"notifications": "ddp"` or `"poll"`.
- `--stdout` runs keep their own state (`state.stdout.json`) and heartbeat, so
  a test run no longer consumes the cursors and seen ids of the live daemon.
  Any state file other than `state.json` now gets its own `NAME.health`.

### Added

- `--lists all` watches every list the hub shows you in the rooms you belong
  to, re-read every 15 minutes.
- `file` events work without `--rooms` and then watch every joined room.
  Lists and rooms are polled one at a time within the hub rate limit.

### Docs

- `--priority-from` has no effect for your own messages: they are always
  skipped.

## 0.4.0 — 2026-10-06

### Added

- `privos subscribe`: a read-only watcher that turns hub DMs, mentions,
  messages, in-app notifications, list items, room files, and board tasks into
  one JSON envelope per event. Realtime over the hub websocket (DDP) with a
  REST backstop, or `--mode poll`. Delivers to stdout (`--stdout`), prints the
  batches it would send (default dry run), or POSTs batches to a webhook with
  `--confirm`. Batching, rate limits, retry with backoff, a durable outbox, and
  at-least-once delivery with stable event ids.
- `privos subscribe status`: heartbeat age, cursors, lag, outbox size, and
  counters; exits `1` when the daemon has not written a heartbeat for 10 minutes.
- `privos hub inbox --since`: one hub poll for cron jobs; prints envelopes and
  the next cursor.
- `--projects ALIAS:PID` watches several boards; alias `X` reads `X_URL` and
  `X_API_ACCESS_KEY`.

## 0.3.0 — 2026-10-06

### Added

- `privos sandbox tasks start`: start an agent attempt on a task the way the
  board UI does, with `--model`, `--provider` or `--llm-provider`, `--effort`,
  `--prompt`, and `--force`.
- `privos sandbox tasks create --start`: create a task and start it in one
  command.
- `privos sandbox tasks attempts`, `conversation`, `running`, and `question`
  to follow a run, and `privos sandbox models list`.
- `privos sandbox tasks answer`: answer an agent's pending question over
  socket.io.

## 0.2.0 — 2026-10-06

### Changed

- The CLI is a Node package (`npx @privos_ai/privos`) instead of a Go binary,
  licensed under MIT.

### Added

- Board and hub writes (projects, tasks, rooms, messages, lists, items). Every
  write is a dry run unless `--confirm`.
