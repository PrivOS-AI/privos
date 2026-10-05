# Hub API

PrivOS Hub is the Rocket.Chat-derived service. On a default self-hosted
install it listens on `http://127.0.0.1:3000` (`PRIVOS_HUB_PORT`). The
installer stores the public origin in `PRIVOS_ROOT_URL`.

User REST calls use base path `/api/v1/` and these headers:

```text
X-User-Id: YOUR_USER_ID
X-Auth-Token: YOUR_TOKEN
```

Create a personal access token in the hub (Account → Personal Access Tokens),
or exchange a username and password once with `POST /api/v1/login` and keep
the returned `userId` and `authToken`. `privos` does not call login and does
not accept a password.

Official overview, including pagination (`count`, `offset`) and the error
shape: [API Overview](https://docs.privos.ai/guide/developer/api-overview.html).

Success responses include `"success": true`. Errors look like:

```json
{"success": false, "error": "Unauthorized", "message": "You must be logged in to do this."}
```

The documented default rate limit is 120 requests per minute per user.

This CLI's hub auth is the user token above. It does not use the bot API
(`Authorization: Bearer`) or MCP OAuth.

## Rooms

`GET /api/v1/rooms.get`

Optional query `updatedSince` (RFC3339 timestamp), from `--updated-since`.

The body has `update` (rooms for this user) and `remove`. The table view
prints `update`. Useful fields: `_id`, `t` (room type), `name`, `fname`.

```text
privos hub rooms list
```

`t` values:

| `t` | Room | Message command |
|---|---|---|
| `c` | Public channel | `--kind channel` |
| `p` | Private group | `--kind group` |
| `d` | Direct message | `--kind direct` |

## Messages

One room per call. `roomId` is required.

| Kind | Method |
|---|---|
| channel (default) | `GET /api/v1/channels.messages?roomId=ROOM_ID` |
| group | `GET /api/v1/groups.messages?roomId=ROOM_ID` |
| direct | `GET /api/v1/im.messages?roomId=ROOM_ID` |

Optional `count` and `offset` are sent only when `--count` or `--offset` is
set. The `messages` array is what the table view prints (`_id`, `ts`,
`u.username`, `msg`).

```text
privos hub messages list --room ROOM_ID --kind channel
```

These paths match the PrivOS API overview (`channels` / room message reads)
and the Rocket.Chat REST API the hub is derived from. A private group will
not list through `channels.messages`; pass `--kind` that matches `t`.

## Lists and items

Lists are a PrivOS feature (structured rows inside a room, with item keys
such as `TASK-42`). The product surface is described in the
[Lists guide](https://docs.privos.ai/guide/lists.html). MCP tools and the bot
API can read items, but the **user-token** method names (`lists.*`,
`items.*` under `/api/v1/`) are not in the public API overview.

Until those method names are confirmed, the CLI only reserves the interface:

```text
privos hub lists list [--room ROOM_ID]
privos hub lists get --id LIST_ID
privos hub items list --list LIST_ID
privos hub items get --id ITEM_ID
```

Each of those exits with a not-wired error and **does not send a request**.
Do not guess a path in CI against a live hub.

When the methods are confirmed, the reads should use the same
`X-User-Id` / `X-Auth-Token` headers as rooms and messages. Writes (create
item, move stage, delete) stay behind a dry run and `--confirm`.

The bot API (`GET /api/v1/bot/lists/{listId}/items` with a bot bearer token)
is a different auth mode and is out of scope for this CLI slice.
