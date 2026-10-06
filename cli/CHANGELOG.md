# Changelog

All notable changes to `@privos_ai/privos`. Full command notes live in
[docs/cli/README.md](https://github.com/PrivOS-AI/privos/blob/main/docs/cli/README.md).

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
  `HTTP 403: a2a-sender-not-on-roster: ...`.

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
