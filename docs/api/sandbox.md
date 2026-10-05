# Sandbox board API

The sandbox board is the Next.js service in the `sandbox-board` container.
On a default self-hosted install it listens on `http://127.0.0.1:8556`
(`PRIVOS_BOARD_PORT`). A hosted board looks like `https://tvibe.roxane.one`.

`privos sandbox` calls only the reads below. Health for the container is
`GET /api/bot/health` (no API key); the CLI does not use that path.

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

## List projects

`GET /api/projects`

Response: a JSON array. Each object has at least `id` and `name`.

```text
privos sandbox projects list
```

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
| `ids` | — | Not exposed yet. The board client can request tasks by id. |

Response: a JSON array. Fields the CLI table prints: `id`, `title`,
`status`, `projectId`.

```text
privos sandbox tasks list --project PROJECT_ID --status todo
```

There is also `GET /api/tasks/{id}` for one task. The CLI does not call it yet.

## Not called by this CLI

The board UI also creates, updates, deletes, and reorders tasks, and creates
and deletes projects. Those are not CLI commands. A later write command has
to dry-run by default and require `--confirm`. Do not point CI at a live board.
