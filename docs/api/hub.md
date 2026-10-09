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

This CLI's hub auth is the user token above, with one exception: an agent bot
authenticates with its bot key (`Authorization: Bearer`, `--bot-key` or
`PRIVOS_BOT_KEY`), or, inside an agent VM, through the sandbox proxy. See
[Bot mode](#bot-mode-agent-bots) and [Sandbox egress](#sandbox-egress). The CLI
does not use MCP OAuth.

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

### Members, invite, kick, archive

Commands for an agent bot (see [Bot mode](#bot-mode-agent-bots)); they also work
with a personal token. `--kind` picks `channels.*` or `groups.*`.

| CLI | Method | Body or query |
|---|---|---|
| `hub rooms members --room ROOM_ID` | `GET /api/v1/channels.members` or `groups.members` | `roomId` |
| `hub rooms invite --room ROOM_ID --member USER_ID...` | `POST /api/v1/channels.invite` or `groups.invite` | `{"roomId","userIds"}` |
| `hub rooms kick --room ROOM_ID --member USER_ID...` | `POST /api/v1/channels.kick` or `groups.kick` | `{"roomId","userId"}`, one request per member |
| `hub rooms archive --room ROOM_ID` | `POST /api/v1/channels.archive` or `groups.archive` | `{"roomId"}` |

`--member` is a user id here (`rooms create` takes usernames). `rooms update --name` is the
rename.

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

User-token method names below come from PrivOS-AI/privos-hub:

- `apps/meteor/server/services/mcp-rest-allowlist.ts`
- `apps/meteor/app/api/server/v1/lists.ts`
- `apps/meteor/app/api/server/v1/items.ts`

Every call uses `X-User-Id` and `X-Auth-Token` and base path `/api/v1/`.
Writes are `POST` and stay a dry run until `--confirm`.

The calls below use a user token. This CLI does **not** call the `/api/v1/bot/lists/...`
routes or MCP tool names (`privos.lists.*`); those are a different auth mode. An agent bot
uses the room routes in [Bot mode](#bot-mode-agent-bots) instead. The bot routes are documented in the
[bot workflow guide](https://docs.privos.ai/guide/how-to/create-bot-workflow.html).
The MCP tools are documented in
[MCP Apps](https://docs.privos.ai/guide/developer/apps-development.html).

### List reads

| CLI | Method |
|---|---|
| `hub lists list` | `GET /api/v1/lists.list` |
| `hub lists list --room ROOM_ID` | `GET /api/v1/lists.listByRoomId?roomId=ROOM_ID` |
| `hub lists get --id LIST_ID` | `GET /api/v1/lists.info?listId=LIST_ID` |

`lists.list` is called with no query. The table view prints a `lists` array
when the body has one. `lists get` prints JSON.

```text
privos hub lists list
privos hub lists list --room ROOM_ID
privos hub lists get --id LIST_ID
```

### List writes

| CLI | Method | Body |
|---|---|---|
| `hub lists create --room ROOM_ID` | `POST /api/v1/lists.create` | `roomId` required. `fieldDefinitions` required; the CLI sends `[]` unless `--field-definitions` is a JSON array. Optional `name`, `description`, `crossTeamWorkflow` (`--cross-team true\|false`), `isolatedList` (`--isolated true\|false`). |
| `hub lists update --id LIST_ID` | `POST /api/v1/lists.update` | `listId` required. Optional `name`, `description`, `roomId`, `crossTeamWorkflow`, `isolatedList`. At least one optional field is required. |
| `hub lists delete --id LIST_ID` | `POST /api/v1/lists.delete` | `{"listId":"LIST_ID"}` |

`lists.create` responds with `{ list, defaultStage }`. Use `defaultStage` as
`--stage` on item create when you do not already have a stage id.

```text
privos hub lists create --room ROOM_ID --name Tasks
privos hub lists create --room ROOM_ID --name Tasks --confirm
privos hub lists update --id LIST_ID --name Renamed --cross-team true --confirm
privos hub lists delete --id LIST_ID --confirm
```

### Item reads

| CLI | Method |
|---|---|
| `hub items list --list LIST_ID` | `GET /api/v1/items.listByListId?listId=LIST_ID` |
| same, plus `--include-sub-items` | adds `includeSubItems=true` |
| `hub items list --list LIST_ID` with `--stage`, `--parent`, `--count`, `--offset`, `--sort`, or `--after` | `GET /api/v1/items.list?listId=LIST_ID` plus the filters that were set (`stageId`, `parentId`, `count`, `offset`, `sort`, `after`) |
| `hub items list --stage STAGE_ID` | `GET /api/v1/items.listByStageId?stageId=STAGE_ID` |
| `hub items list --parent ITEM_ID` | `GET /api/v1/items.listByParentId?parentId=ITEM_ID` |
| `hub items get --id ITEM_ID` | `GET /api/v1/items.info?itemId=ITEM_ID` |
| `hub items search --list LIST_ID --term TEXT` | `GET /api/v1/items.search?listId=LIST_ID&searchTerm=TEXT` |
| `hub items find --list LIST_ID --field FIELD_ID --value VALUE` | `GET /api/v1/items.findByFieldValue?listId=LIST_ID&fieldId=FIELD_ID&value=VALUE` |

`--include-sub-items` cannot be combined with the `items.list` filters.
`--stage` alone and `--parent` alone are separate endpoints; combining either
with `--list` uses `items.list` instead. The table view prints an `items`
array when the body has one.

```text
privos hub items list --list LIST_ID
privos hub items list --list LIST_ID --include-sub-items
privos hub items list --list LIST_ID --stage STAGE_ID --count 20
privos hub items get --id ITEM_ID
privos hub items search --list LIST_ID --term draft
privos hub items find --list LIST_ID --field FIELD_ID --value done
```

### Item writes

| CLI | Method | Body |
|---|---|---|
| `hub items create --list LIST_ID --stage STAGE_ID` | `POST /api/v1/items.create` | `listId` and `stageId` required. Optional `name`, `description`, `parentId` (`--parent`), `customFields` (`--custom-fields`, a JSON array). |
| `hub items update --id ITEM_ID` | `POST /api/v1/items.update` | `itemId` required. Optional `name`, `description`, `stageId`, `customFields`, `archived` (`--archived true\|false`), `order` (`--order`, an integer), `showArchivedSubItems` (`--show-archived-sub-items true\|false`). At least one optional field is required. |
| `hub items delete --id ITEM_ID` | `POST /api/v1/items.delete` | `{"itemId":"ITEM_ID"}` |
| `hub items move --id ITEM_ID --stage STAGE_ID` | `POST /api/v1/items.moveToStage` | `{"itemId","stageId"}` |
| `hub items reorder --id ITEM_ID --order N` | `POST /api/v1/items.updateOrder` | `{"itemId","newOrder"}` |

`--order` on `items update` is the `order` field of `items.update`.
`items reorder` is the separate `items.updateOrder` method.

```text
privos hub items create --list LIST_ID --stage STAGE_ID --name Draft
privos hub items create --list LIST_ID --stage STAGE_ID --name Draft --confirm
privos hub items update --id ITEM_ID --description 'notes' --confirm
privos hub items move --id ITEM_ID --stage STAGE_ID --confirm
privos hub items reorder --id ITEM_ID --order 10 --confirm
privos hub items delete --id ITEM_ID --confirm
```

## Bot mode (agent bots)

With `--bot-key` or `PRIVOS_BOT_KEY`, or through the [egress](#sandbox-egress), the
CLI runs as an agent bot. Bot keys cannot use the public `lists.*`, `items.*` and
`stages.*` routes, so `hub lists` and `hub items` call the room routes below
instead. `--room` is required (default `PRIVOS_ROOM_ID`) and is validated as one
path segment; `--name` is required on `lists create` and `items create`. Writes stay
a dry run until `--confirm`. `--raw` prints the hub's bytes unchanged.

| CLI | Method and route (base `/api/v1/internal/rooms/ROOM_ID`) |
|---|---|
| `hub lists list` | `GET .../lists` |
| `hub lists get --id L` | `GET .../lists/L` (prints `list`, `stages`, `itemCount`) |
| `hub lists create --name N` | `POST .../lists` |
| `hub lists update --id L` | `PUT .../lists/L` |
| `hub lists delete --id L` | `DELETE .../lists/L` |
| `hub items list --list L` or `--stage S` | `GET .../items?listId=L` or `?stageId=S` |
| `hub items get --id I` | `GET .../items/I` (prints `item` and `children`) |
| `hub items create --list L --stage S --name N` | `POST .../items` |
| `hub items update --id I` | `PUT .../items/I` |
| `hub items delete --id I` | `DELETE .../items/I` |
| `hub items move --id I --stage S` | `POST .../items/I/move` |

The room routes leave some options out, so these are refused with a usage error before
any request: `--isolated`; on `items update` `--archived`, `--order` and
`--show-archived-sub-items`; on `items list` `--parent`, `--sort`, `--after`,
`--include-sub-items`, `--list` together with `--stage`, and `--count` or `--offset`
with `--stage`; and the commands `items search`, `items find` and `items reorder`.

On a list owned by an MCP app, item writes (not list or stage changes) succeed only for
a bot that an admin marked as a super agent and only in rooms where its owner holds
owner, admin or leader. Otherwise the hub answers with the app-owned error.

### DM reply

`privos hub dm reply --room DM_ROOM_ID --text TEXT` calls
`POST /api/v1/agents.superAgent.dmReply` with `{"roomId","text"}`. A super agent uses
it to answer one of its owner's one-to-one DMs in the owner's name, with a "sent by
agent" badge. It works only over the egress, because the hub accepts it only from the
agent room session; a personal token or a bare bot key is refused before any request.
It is a dry run unless `--confirm`.

The owner's setting decides the outcome and the agent cannot change it:

| `status` | Meaning |
|---|---|
| `drafted` | A draft card with Send and Discard appeared in the agent room. Nothing is posted until the owner presses Send. The response carries `draftId`, `cardMessageId`, `expiresAt` |
| `sent` | The owner allowed replies on their behalf; the message is posted and the response carries `messageId` |

The JSON goes to stdout and a one-line explanation to stderr. A second reply for the same
DM replaces the pending draft. Errors print the hub's code first, for example
`error-not-owner-dm` or `error-super-agent-inactive`.

## Sandbox egress

An agent VM holds no bot key. With `PRIVOS_SANDBOX_MODE=true`, `PROXY_URL` and
`PROXY_TOKEN` set, and no credential of your own (no flag and none of `PRIVOS_BOT_KEY`,
`PRIVOS_HUB_USER_ID`, `PRIVOS_USER_ID`, `PRIVOS_HUB_AUTH_TOKEN`, `PRIVOS_PAT`), the
commands `hub rooms|lists|items|dm` and `agents a2a` send each request through the sandbox
proxy:

```text
POST $PROXY_URL/egress
x-proxy-token: ...
{"url": "https://HUB/api/v1/...", "method": "POST", "headers": {...}, "body": "<string>"}
```

The proxy matches the URL against the agent's catalog and attaches the bot key; the CLI
sends no `Authorization`, `X-User-Id` or `X-Auth-Token`. The hub URL is `--url`, else
`PRIVOS_HUB_URL`, else `https://$PRIVOS_HUB_HOST`. The proxy decides what the agent may call, and a
refusal prints its code first, for example `HTTP 403: no-binding: ...`.

Over the egress `hub rooms update --topic` and `hub rooms delete` are refused: the catalog
does not open `setTopic` or `delete`. `hub get`, `subscribe` and `sandbox tasks answer`
never use the egress and fail with a clear message in a VM that gives them no connection
of their own.

## Read-route catalog

`privos hub get --route ROUTE [--param key=value ...]` sends
`GET /api/v1/ROUTE?key=value` with your own `X-User-Id` and `X-Auth-Token` and
prints the JSON body. It works for any hub GET route, so a route added to the
hub needs no CLI release. The hub applies your permissions and answers
`HTTP 403: <error>` when the route is not yours. A bot key is never sent
(`--bot-key` is refused and `PRIVOS_BOT_KEY` is ignored), and `--format table`
is not supported because the body shape is route-specific.

```text
privos hub get --route channels.members --param roomId=GENERAL
privos hub get --route chat.getMessage --param msgId=MESSAGE_ID
```

The hub keeps a catalog that classifies every GET route in
`apps/meteor/lib/universal-bot-rest-read-catalog.ts` (PrivOS-AI/privos-hub). The
Universal Assistant calls the same routes through `assistant.rest-get`, as the
human it is chatting with, under three tiers:

| Tier | Who may use the route through the assistant |
|---|---|
| `user` | Any signed-in human; the route's own permission check still applies. |
| `room-owner` | The owner of the room named in the request, or an administrator. |
| `admin` | Administrators. Off until an administrator enables it. |

An administrator edits the tiers in a tier matrix (Admin → Settings → Universal
Assistant): routes can be enabled, disabled, or moved one by one or by group.
Only the deviations from the catalog defaults are stored. Routes in the
catalog's never-list (secrets, tokens, side-effecting or unbounded reads)
cannot be enabled. The tiers limit the assistant only; `hub get` is bounded by
your own permissions.

Maintenance rule: every new hub GET route needs one catalog line (a tier,
never, or excluded). `scripts/release-audit.mjs` in the hub refuses to build a
release with an unclassified GET route. Once classified, the route reaches the
assistant on every tenant with the next hub release and is available to
`hub get` immediately.

### Confirmed, and not called by this CLI

| Method | Why it is not a command |
|---|---|
| `GET /api/v1/lists.fields.list` | Confirmed read. Query parameters were not specified, so the CLI does not guess them. |
| `POST /api/v1/lists.addField` | Field CRUD. Skipped so the flag surface stays on list and item records. |
| `POST /api/v1/lists.removeField` | Same. |
| `POST /api/v1/lists.fields.create` | Same. |
| `POST /api/v1/lists.fields.update` | Same. |
| `POST /api/v1/lists.fields.delete` | Same. |
| `POST /api/v1/items.bulkUpdateOrder` | Bulk reorder is awkward as flags. One item uses `hub items reorder`. |
| `stages.*` | Not part of the confirmed list/item method set above. `items.create` takes `--stage` from the operator. `lists.create` returns `defaultStage`. `stages.listByListId` was not verified in this change, so there is no `hub stages` command. |
