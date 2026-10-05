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

Room and message writes use the method names in that overview and in the
Rocket.Chat REST API the hub is derived from (Rocket.Chat 7.9.1). They are
not guessed names.

## Rooms

`GET /api/v1/rooms.get`

Optional query `updatedSince` (RFC3339 timestamp), from `--updated-since`.

The body has `update` (rooms for this user) and `remove`. The table view
prints `update`. Useful fields: `_id`, `t` (room type), `name`, `fname`.

```text
privos hub rooms list
```

`t` values:

| `t` | Room | Message list | Writes |
|---|---|---|---|
| `c` | Public channel | `--kind channel` | `channels.*` |
| `p` | Private group | `--kind group` | `groups.*` |
| `d` | Direct message | `--kind direct` | not a write target |

### Create

| Kind | Method | Body |
|---|---|---|
| channel (default) | `POST /api/v1/channels.create` | `name` required. Optional `members` (array of usernames), `readOnly`, `excludeSelf`. |
| group | `POST /api/v1/groups.create` | Same fields. |

`channels.create` is listed in the PrivOS API overview. `groups.create` is the
Rocket.Chat method for a private room, with the same body. Omitted booleans
are left to the server default (`readOnly` false, `excludeSelf` false).

```text
privos hub rooms create --name ops --member ada
privos hub rooms create --kind group --name private-ops --confirm
```

### Update

| Change | Channel | Group | Body |
|---|---|---|---|
| Rename | `POST /api/v1/channels.rename` | `POST /api/v1/groups.rename` | `{"roomId","name"}` |
| Topic | `POST /api/v1/channels.setTopic` | `POST /api/v1/groups.setTopic` | `{"roomId","topic"}` |

Both flags send rename first, then topic. `--kind` defaults to channel.

```text
privos hub rooms update --room ROOM_ID --name new-name --topic 'ship it' --confirm
```

### Delete

| Kind | Method | Body |
|---|---|---|
| channel | `POST /api/v1/channels.delete` | `{"roomId"}` |
| group | `POST /api/v1/groups.delete` | `{"roomId"}` |

```text
privos hub rooms delete --room ROOM_ID --kind group --confirm
```

There is no direct-message delete command. `im.close` was not confirmed as
the method to expose.

## Messages

### List

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

A private group will not list through `channels.messages`. Pass `--kind`
that matches `t`.

### Send, update, delete

These are user-token `POST`s. `chat.sendMessage` is named in the PrivOS API
overview. `chat.update` and `chat.delete` are the Rocket.Chat methods for
editing and deleting a message.

| Action | Method | Body |
|---|---|---|
| Send | `POST /api/v1/chat.sendMessage` | `{"message":{"rid":"ROOM_ID","msg":"TEXT"}}` |
| Update | `POST /api/v1/chat.update` | `{"roomId","msgId","text"}` |
| Delete | `POST /api/v1/chat.delete` | `{"roomId","msgId"}` |

`asUser` is omitted on delete, so the server default (`false`) applies.
`--kind` is not used: the room id selects the room.

```text
privos hub messages send --room ROOM_ID --text 'hello' --confirm
privos hub messages update --room ROOM_ID --id MSG_ID --text 'edited' --confirm
privos hub messages delete --room ROOM_ID --id MSG_ID --confirm
```

Every write above is a dry run until `--confirm`.

## Lists and items

Lists are a PrivOS feature (structured rows inside a room, with item keys
such as `TASK-42`). The product surface is described in the
[Lists guide](https://docs.privos.ai/guide/lists.html).

### Blocker: no confirmed user-token method names

The public [API overview](https://docs.privos.ai/guide/developer/api-overview.html)
does not name `lists.*` or `items.*` under `/api/v1/` with `X-User-Id` and
`X-Auth-Token`. Rocket.Chat 7.9.1, which the hub is derived from, has no
matching lists/items REST methods. A public `privos-hub` tree was not
available to read. The CLI therefore still does not send these commands:

```text
privos hub lists list [--room ROOM_ID]
privos hub lists get --id LIST_ID
privos hub items list --list LIST_ID
privos hub items get --id ITEM_ID
```

Each exits with a not-wired error and **does not send a request**.

Names that do exist, and that this CLI does **not** call, because they are a
different auth mode:

| Surface | What was confirmed | Auth |
|---|---|---|
| Bot HTTP | `GET` and `POST /api/v1/bot/lists/{listId}/items` with body `{"title","fields","stage"}`; `PUT /api/v1/bot/lists/{listId}/items/{itemId}/stage` with `{"stage"}` | `Authorization: Bearer` bot token. Documented in the [bot workflow guide](https://docs.privos.ai/guide/how-to/create-bot-workflow.html). |
| MCP app tools | `privos.lists.getAll`, `privos.lists.get`, `privos.lists.create`, `privos.lists.updateList`, `privos.lists.createItem`, `privos.lists.updateItem`, `privos.lists.deleteItem`, `privos.lists.moveItemToStage` | MCP app OAuth, not the user token. Documented in [MCP Apps](https://docs.privos.ai/guide/developer/apps-development.html). |

Those are not wired behind `X-User-Id` / `X-Auth-Token`, and the CLI does not
pretend the MCP tool names are `/api/v1/` routes. When a user-token method
name is confirmed, the reads and writes should use the same headers as rooms
and messages, and writes should stay behind `--confirm`.
