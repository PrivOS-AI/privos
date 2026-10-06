# Changelog

All notable changes to `@privos_ai/privos`. Full command notes live in
[docs/cli/README.md](https://github.com/PrivOS-AI/privos/blob/main/docs/cli/README.md).

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
