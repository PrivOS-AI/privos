# privos CLI

`privos` is a single operator CLI for a running PrivOS install. It talks to
two APIs:

- **sandbox** — the sandbox board (projects and tasks)
- **hub** — the PrivOS Hub (Rocket.Chat-derived rooms and messages, plus
  lists and items)

It does not install, upgrade, uninstall, or sign a release. `install.sh`,
`compose.yml`, and `publish-self-hosted-bundle.sh` are unchanged. The CLI is
not part of the minisign-signed install bundle.

## Install

The CLI is a Node package. The command name is `privos`.

```bash
npm install -g @privos_ai/privos
privos --help

# or, without a global install
npx @privos_ai/privos --help
```

From a checkout of this repository:

```bash
cd cli
npm install
npm test
npm run build
node dist/main.js --help
```

`npm pack` (run from `cli/`) produces the tarball. Releases are published by
the `publish-cli` workflow (`.github/workflows/publish-cli.yml`): bump the
version in `cli/package.json` on `main`, run the workflow from the Actions tab,
and approve the `release` environment. It uses npm trusted publishing, so no
npm token is stored in this repository.

The package name is `@privos_ai/privos`. That is the npm org already used by
`@privos_ai/app-server`, `@privos_ai/app-cluster`, and
`@privos_ai/privos-agent-sdk`. The unscoped name `privos` and the scope
`@privos-ai` are not the published org.

Requires Node.js 20 or newer. The only runtime dependency is socket.io-client,
used by `tasks answer`.

### Why this is not the Go binary

The first CLI (0.1.0) was a Go 1.22 program. An npm wrapper around that binary
would still need a multi-platform build and a place to download it from, and
this repository's signed release bundle must not grow a download step. The Go
tree is removed in this version so there is one implementation: the Node
package users run with `npx` or `npm install`.

## Configuration

Flags override environment variables. Empty variables are ignored. Prefer
environment variables for keys and tokens so they are not copied into the
process list. Do not put credentials in the URL.

| Target | Flag | Environment | Sent as |
|---|---|---|---|
| Sandbox base URL | `--url` | `PRIVOS_SANDBOX_URL` | request URL |
| Sandbox API key | `--api-key` | `PRIVOS_SANDBOX_API_KEY`, then `API_ACCESS_KEY`, then `SANDBOX_API_KEY` | `x-api-key` |
| Hub base URL | `--url` | `PRIVOS_HUB_URL`, then `PRIVOS_ROOT_URL` | request URL |
| Hub user id | `--user-id` | `PRIVOS_HUB_USER_ID`, then `PRIVOS_USER_ID` | `X-User-Id` |
| Hub auth token | `--auth-token` | `PRIVOS_HUB_AUTH_TOKEN`, then `PRIVOS_PAT` | `X-Auth-Token` |
| Hub bot key | `--bot-key` | `PRIVOS_BOT_KEY` | `Authorization: Bearer` (replaces the two rows above; `hub` and `agents` commands only, never `hub get`) |

Inside an agent VM there is no bot key at all; see [Bot mode and sandbox egress](#bot-mode-and-sandbox-egress).

`API_ACCESS_KEY` is the name the board container uses. `SANDBOX_API_KEY` is
the name `install.sh` writes into the stack `.env`. `PRIVOS_ROOT_URL` is the
public hub URL the installer already records.

On a default self-hosted install the board listens on `http://127.0.0.1:8556`
and the hub on `http://127.0.0.1:3000` (see `PRIVOS_BOARD_PORT` and
`PRIVOS_HUB_PORT`). The CLI does not read `/opt/privos/.env` by itself.

Shared flags:

| Flag | Meaning |
|---|---|
| `--format json\|table` | Default `json`. `table` is a plain-text view of a list read. Writes always print JSON. |
| `--raw` | Print a live response body unchanged. |
| `--timeout SECONDS` | HTTP timeout, 1–300. Default 30. |
| `--confirm` | Send a write. Required for every mutating command. |
| `--dry-run` | Print the write and send nothing. This is the default. Cannot be combined with `--confirm`. |
| `--help`, `-h` | Help for the current command. |

Exit codes: `0` success (including a dry run), `2` usage or missing config,
`1` the request failed or the response could not be shown.

The HTTP client does not follow redirects, so a credential header is not
replayed onto another host. Errors print the HTTP status and a message from
the JSON body. They do not print the API key or the hub token.

## Commands

```text
privos sandbox projects list
privos sandbox projects create --name NAME --path ABS_PATH [--hook-template]
privos sandbox projects create --sandbox --name NAME [--auto-start] [--hook-template]
privos sandbox projects update --id ID [--name NAME] [--autopilot off|autonomous]
privos sandbox projects delete --id ID
privos sandbox projects start --id ID

privos sandbox tasks list [--project ID] [--status STATUS] [--limit N] [--after CURSOR]
privos sandbox tasks create --project ID --title TITLE [--description TEXT] [--status STATUS]
privos sandbox tasks create --project ID --title TITLE --description TEXT --start [--model M] [--provider P | --llm-provider ID] [--effort E]
privos sandbox tasks update --id ID [--title T] [--description TEXT] [--status STATUS] [--position N] [--chat-init true|false]
privos sandbox tasks delete --id ID
privos sandbox tasks start --id ID [--model M] [--provider P | --llm-provider ID] [--effort E] [--prompt TEXT] [--force]
privos sandbox tasks attempts --id ID
privos sandbox tasks conversation --id ID [--limit N] [--before MS]
privos sandbox tasks running --id ID
privos sandbox tasks question --id ID
privos sandbox tasks answer --id ID --answer TEXT [--answer TEXT ...]

privos sandbox models list

privos hub get --route ROUTE [--param key=value ...]

privos hub rooms list [--updated-since RFC3339]
privos hub rooms create --name NAME [--kind channel|group] [--member USER] [--read-only] [--exclude-self]
privos hub rooms update --room ID [--kind channel|group] [--name NEW] [--topic TEXT]
privos hub rooms delete --room ID [--kind channel|group]
privos hub rooms members --room ID [--kind channel|group]
privos hub rooms invite --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]
privos hub rooms kick --room ID --member USER_ID [--member USER_ID ...] [--kind channel|group]
privos hub rooms archive --room ID [--kind channel|group]

privos hub dm reply --room DM_ROOM_ID --text TEXT            # agent VM only, see "Bot mode and sandbox egress"

privos hub messages list --room ROOM_ID [--kind channel|group|direct] [--count N] [--offset N]
privos hub messages send --room ROOM_ID --text TEXT
privos hub messages update --room ROOM_ID --id MSG_ID --text TEXT
privos hub messages delete --room ROOM_ID --id MSG_ID

privos hub lists list [--room ROOM_ID]
privos hub lists get --id LIST_ID
privos hub lists create --room ROOM_ID [--name NAME] [--description TEXT] [--field-definitions JSON] [--cross-team true|false] [--isolated true|false]
privos hub lists update --id LIST_ID [--name NAME] [--description TEXT] [--room ROOM_ID] [--cross-team true|false] [--isolated true|false]
privos hub lists delete --id LIST_ID

privos hub items list --list LIST_ID [--include-sub-items]
privos hub items list --list LIST_ID [--stage STAGE_ID] [--parent ITEM_ID] [--count N] [--offset N] [--sort SORT] [--after CURSOR]
privos hub items list --stage STAGE_ID
privos hub items list --parent ITEM_ID
privos hub items get --id ITEM_ID
privos hub items search --list LIST_ID --term TEXT
privos hub items find --list LIST_ID --field FIELD_ID --value VALUE
privos hub items create --list LIST_ID --stage STAGE_ID [--name NAME] [--description TEXT] [--parent ITEM_ID] [--custom-fields JSON]
privos hub items update --id ITEM_ID [--name NAME] [--description TEXT] [--stage STAGE_ID] [--custom-fields JSON] [--archived true|false] [--order N] [--show-archived-sub-items true|false]
privos hub items delete --id ITEM_ID
privos hub items move --id ITEM_ID --stage STAGE_ID
privos hub items reorder --id ITEM_ID --order N

privos hub inbox --since ISO|EPOCH_MS [--events dm,mention,message,notification] [--rooms LIST] [--include-text]

privos agents a2a send --team TEAM_ID --room ROOM_ID --to BOT_ID,...|team --kind KIND [--correlation C_ID] [--reply-to M_ID]
                       [--priority urgent|fyi] [--text TEXT] [--data JSON_OBJECT] [--file-id ID ...] [--deadline-at ISO] [--message-id M_ID]
privos agents a2a members --team TEAM_ID
privos agents a2a chain --correlation C_ID [--count N] [--offset N]
privos agents a2a stop --correlation C_ID [--team TEAM_ID] [--room ROOM_ID] [--text REASON]

privos subscribe [--events LIST] [--rooms LIST] [--lists LIST|all] [--projects BOARD:PID,...]
                 [--priority-from USERS] [--mode realtime|poll] [--state PATH]
                 [--stdout | --dry-run | --confirm] [--include-text] [--exclude-bots] [--group-mentions]
                 [--webhook-url-env NAME] [--webhook-key-env NAME] [--webhook-header NAME]
privos subscribe status [--state PATH]
```

`--project` may be repeated on `tasks list`. Task create takes exactly one
`--project`. Task status values the board UI uses include `todo`,
`in_progress`, `in_review`, `done`, and `cancelled`. Other values are passed
through.

Room type `t` from `hub rooms list` selects `--kind` for message reads and
for room writes that differ by room type:

| `t` | `--kind` | Message read | Room create / delete / rename / topic |
|---|---|---|---|
| `c` | `channel` (default) | `GET /api/v1/channels.messages` | `channels.create`, `channels.delete`, `channels.rename`, `channels.setTopic` |
| `p` | `group` | `GET /api/v1/groups.messages` | `groups.create`, `groups.delete`, `groups.rename`, `groups.setTopic` |
| `d` | `direct` | `GET /api/v1/im.messages` | not a write target |

`hub messages send`, `update`, and `delete` use `chat.sendMessage`,
`chat.update`, and `chat.delete`. Those take a room id, so they do not use
`--kind`.

List and item reads are `GET /api/v1/lists.*` and `GET /api/v1/items.*`.
List and item writes are `POST` and stay a dry run until `--confirm`.
`lists.create` sends `fieldDefinitions: []` unless `--field-definitions` is
a JSON array, and its response includes `defaultStage` for
`hub items create --stage`. Field CRUD (`lists.addField`, `lists.fields.*`),
`items.bulkUpdateOrder`, and `stages.*` are not commands. The CLI does not
call `/api/v1/bot/lists` or MCP `privos.lists.*`. See [Hub API](../api/hub.md).

## Bot mode and sandbox egress

An agent bot runs hub commands with its own key (`--bot-key` or `PRIVOS_BOT_KEY`, sent as
`Authorization: Bearer`). Bot keys cannot use the public `lists.*`, `items.*` and
`stages.*` routes, so in bot mode `hub lists` and `hub items` call the room routes
`/api/v1/internal/rooms/ROOM_ID/...` instead:

- `--room` is required (default `PRIVOS_ROOM_ID`); `--name` is required on `lists create` and `items create`.
- Options the room routes would silently ignore are refused with a usage error before any request:
  `--isolated`; on `items update` `--archived`, `--order` and `--show-archived-sub-items`; on `items list` `--parent`,
  `--sort`, `--after`, `--include-sub-items` and combining `--list` with `--stage`. `items search`, `items find`
  and `items reorder` are refused too.
- `hub rooms create|update|members|invite|kick|archive` manage channels and private groups. `invite` and `kick` take
  user ids (`hub rooms members` prints them); `rooms update --name` is the rename.
- On a list owned by an MCP app, item writes work only for a super agent in a room where its owner holds
  owner, admin or leader. The hub answers with the app-owned error otherwise.

Route-by-route detail: [Hub API](../api/hub.md#bot-mode-agent-bots). Personal-token mode is unchanged.

**Sandbox egress.** An agent VM never holds the bot key. When `PRIVOS_SANDBOX_MODE=true` and both `PROXY_URL`
and `PROXY_TOKEN` are set, and the command has no credential of its own (no flag, none of `PRIVOS_BOT_KEY`,
`PRIVOS_HUB_USER_ID`, `PRIVOS_USER_ID`, `PRIVOS_HUB_AUTH_TOKEN`, `PRIVOS_PAT`), the commands `hub rooms|lists|items|dm`
and `agents a2a` send each request as `POST $PROXY_URL/egress` with an `x-proxy-token` header, and the proxy
attaches the key. The hub is `--url`, else `PRIVOS_HUB_URL`, else `https://$PRIVOS_HUB_HOST`. The proxy decides what
the agent may call: a refusal prints its code first, for example `HTTP 403: no-binding: ...`, and an unreachable proxy
prints `sandbox proxy egress: ...`. `hub rooms update --topic` and `hub rooms delete` are refused over egress because
the catalog does not open them. `hub get`, `subscribe` and `sandbox tasks answer` never use egress and say so when a VM
leaves them without a connection of their own.

**DM reply.** `privos hub dm reply --room DM_ROOM_ID --text TEXT` asks the hub to answer one of the owner's
one-to-one DMs in the owner's name, with a "sent by agent" badge. It works only over egress, because the hub
accepts it only from the agent room session. The owner's setting decides the result and the agent cannot change it:
`status: drafted` waits for the owner to press Send on the draft card in the agent room, `status: sent` was posted at
once. The JSON is printed to stdout and a one-line explanation to stderr. It is a dry run unless `--confirm`.

## Agent bot-to-bot messages

`privos agents a2a` drives the hub's bot-to-bot protocol (`agents.a2a.send`,
`agents.a2a.team.members`, `agents.a2a.list`) from outside the sandbox, for
example from an external master agent. (Inside an agent VM the commands go through the
sandbox egress instead; see [Bot mode and sandbox egress](#bot-mode-and-sandbox-egress).)
It authenticates as an agent bot:
set `PRIVOS_BOT_KEY` (or `--bot-key`) and the CLI sends
`Authorization: Bearer <key>` and no `X-User-Id` or `X-Auth-Token`. Agent bots
cannot mint personal access tokens, so a bot key is the only credential that
works. A human personal access token is refused by the route with
`a2a-sender-ineligible`, because only an agent bot may send.
The key is never printed; a dry run shows `authorization` under
`omittedHeaderNames`.

```bash
export PRIVOS_HUB_URL=https://hub.example.com PRIVOS_BOT_KEY=...
privos agents a2a members --team TEAM_ID --format table
privos agents a2a send --team TEAM_ID --room ROOM_ID --to BOT_ID --kind task \
  --text "Summarize the open incidents" --confirm     # prints the new correlationId
privos agents a2a chain --correlation C_ID --format table
privos agents a2a stop --correlation C_ID --confirm
```

Sends and stops are a dry run until `--confirm`, like every write. `send`
generates the `messageId` (the idempotency key); pass `--message-id` only to
retry the same send. Omit `--correlation` to start a chain; the hub mints the id
and returns it. `stop` sends `kind: stop` to the team and only the chain
initiator may do it (`a2a-stop-not-allowed` otherwise); it reads the chain's team
and room with one GET unless you pass them. For `needs-approval` and `question`
pass `--data '{"approval":{"action":"..."}}'` or `--data '{"options":["a","b"]}'`.

A recipient is reachable when it has the same owner as the bot, when both are
on an agent team (`--team`) whose room each owner enabled for streaming, or, in
the room the bot acts in, when its owner enabled streaming and "Allow everyone
using this Agent" there. `--team` is needed only for the team path and for
`--to team`. A caller holding a bot key is treated as acting in that bot's own
agent room, so a send to another room is a cross-room call: allowed for the
same owner (who must be a member of the room) and for a streaming team, refused
otherwise. A refusal prints the hub's code first, for example
`HTTP 403: a2a-owner-mismatch: ...`.

Pairing with `privos subscribe`: send with `agents a2a send`, then watch the
results arrive in the team room with `privos subscribe --events message --rooms
ROOM_ID` using your own human credentials (subscribe reads the room as you and
does not use the bot key). Read one chain on demand with `agents a2a chain`.

## Subscribe

`privos subscribe` is a read-only watcher that turns hub and board activity
into one JSON envelope per event. It is meant to run as a long-lived service
(systemd `--user` or pm2) and hand events to a webhook.

It only reads. Toward the hub and boards it sends `GET` requests and, on the
hub websocket, the DDP `connect`, `login` (the personal access token as a
resume token), and `sub` frames. Any other DDP method is refused. It never
posts to PrivOS and never creates integrations.

| Event | Source |
|---|---|
| `dm`, `mention`, `message` | DDP `stream-room-messages` `__my_messages__`; backstop `subscriptions.get?updatedSince` then `chat.syncMessages` |
| `notification` | DDP `in_app_notifications.updates`; backstop `in-app-notifications.list` (every 60 s when the hub refuses the DDP feed) |
| `item` | `items.list?sort=_updatedAt:-1` for each `--lists` id (or every list from `lists.list` with `--lists all`), every 90 s |
| `file` | `file-management.files.filter/:channelId` for each `--rooms` room (every joined room without `--rooms`), every 5 min (full scan) |
| `task` | Board `GET /api/tasks?projectIds=` for each `--projects` board, every 60 s |

`--mode realtime` (default) also subscribes to `<uid>/notification` and
`<uid>/subscriptions-changed`, and runs the REST backstop every 5 minutes.
`--mode poll` polls the hub every 60 seconds. Realtime needs the built-in
`WebSocket` of Node.js 22 or later; on Node.js 20 it falls back to poll. On
start and after each reconnect it reads back from the saved cursor minus two
minutes. The in-app notification publication replays the full history when
it is subscribed; that replay only marks ids as seen. If the hub refuses that
subscription (some hubs answer it with error 500), the daemon logs it, keeps
the message stream on the websocket, and polls `in-app-notifications.list`
every 60 seconds; `privos subscribe status` then shows `"notifications": "poll"` (`"ddp"` when the
feed is live, `"off"` without notification events).

`--projects td:<pid>,tvibe:<pid>` names boards by alias. `td` is the default
board (`PRIVOS_SANDBOX_URL`, `PRIVOS_SANDBOX_API_KEY`). Any other alias `X`
reads `X_URL` and `X_API_ACCESS_KEY`, for example `TVIBE_URL` and
`TVIBE_API_ACCESS_KEY`. The board Socket.IO stream is not used.

Envelope:

```json
{"id":"hub:msg:<_id>","source":"hub","type":"dm","action":"created",
 "ids":{"roomId":"...","messageId":"..."},"actor":{"id":"...","username":"..."},
 "ts":"2026-10-06T08:00:00.000Z","link":"https://hub/direct/<rid>?msg=<_id>",
 "raw_ref":"/api/v1/chat.getMessage?msgId=<_id>"}
```

Ids are `hub:msg:<_id>[:edit:<editedAt>]`, `hub:notif:<_id>`,
`hub:item:<itemId>:<_updatedAt>`, `hub:file:<fileId>:<updated_at|deleted>`, and
`sb:<board>:task:<taskId>:<updatedAt|deleted>`. `summary` (at most 200
characters of message text, item name, file name, or task title) is present
only with `--include-text`. `priority: true` marks DMs, mentions, and
notifications from a `--priority-from` user. Your own messages are always
skipped, so naming yourself in `--priority-from` has no effect.

Filters: your own messages, system messages, hidden and imported messages,
and messages from rooms you have not joined are always skipped.
`--exclude-bots` also skips bot messages. `@all` and `@here` count as
mentions only with `--group-mentions`. `--rooms` (room id or name) limits
messages, notifications, and file watching; `--lists` limits item events and
item notifications. `--lists all` watches every list the hub shows you in the
rooms you belong to (`lists.list`, re-read every 15 minutes); it does not
filter notifications. File events without `--rooms` watch every room you
have joined, including rooms joined later.

Delivery:

| Mode | Behaviour |
|---|---|
| `--stdout` | One envelope per line on stdout. No webhook. |
| default / `--dry-run` | Prints each batch it would POST as `{"dryRun":true,"webhook":{...},"payload":{...}}`. |
| `--confirm` | POSTs `{source, version, batchId, sentAt, events, digest}` to the webhook. |

Batches coalesce for 45 seconds, at most 4 POSTs a minute and 60 events a
POST. Events past 60 are counted in `digest.omitted` and `digest.omittedByType`
instead of sent. The outbox holds at most 2,000 events; overflow is counted in
`digest.dropped`. Events from `--priority-from` users skip the 45-second
window but not the per-minute limit, and they go first in a batch. A failed
POST stays queued and retries after 2 seconds, doubling to 5 minutes with up
to 25% jitter; a 429 `Retry-After` is honoured up to 5 minutes. A 413 halves
the batch size and retries. Any other 4xx except 408 and 429 (a wrong URL,
key, or header) stops the daemon with exit code 1 and keeps the outbox.
Delivery is at least once: a crash between a successful POST and the state
write sends the events again, possibly in a batch with a different `batchId`.
Receivers should dedupe on `events[].id`.

| Webhook setting | Default source |
|---|---|
| URL | `GROK_MASTER_WEBHOOK_URL` (rename with `--webhook-url-env`) |
| Key | `GROK_MASTER_WEBHOOK_KEY` (rename with `--webhook-key-env`) |
| Header carrying the key | `--webhook-header`, else `GROK_MASTER_WEBHOOK_HEADER` |

The URL must be `https` (plain `http` only for localhost). The URL and key
come only from the environment and never appear in logs.

State lives in `~/.privos/subscribe/state.json` (change with `--state`). A dry
run uses `state.dry-run.json` and `--stdout` uses `state.stdout.json` by
default, because they mark events as seen and the `--confirm` daemon must
still deliver them. The state holds the
hub cursors, seen ids (10,000 ids, 7 days), item, file, and task snapshots,
and the outbox. It is written atomically with mode `0600` in a `0700`
directory, and a lock file allows one daemon per state file. With
`--include-text` the outbox holds message text and the file snapshot holds file
names; without it file names are stored only as hashes. A heartbeat is written to
`health` next to `state.json` every 30 seconds; any other state file
`NAME.json` gets `NAME.health`. `privos subscribe status` prints the
heartbeat age, cursors, lag, outbox size, and counters, and exits `1` when
there has been no heartbeat for 10 minutes. It reads `state.json` unless
`--state` names another file, such as `state.stdout.json`. Logs carry ids and counts only.

Hub requests are limited to 20 a minute and hub polls are at least 30 seconds
apart. Lists and rooms are polled one per step, round robin: each list every
90 seconds but no two list reads closer than 10 seconds, and each room every
5 minutes but no two room scans closer than 15 seconds. With 40 lists one
round takes about 7 minutes; with 200 joined rooms about 50 minutes. Polling runs separately from delivery and the heartbeat, so a slow poll
does not hold back a priority event. The hub message cursor is the newest
subscription `_updatedAt` of each `subscriptions.get` snapshot, so a slow poll
cannot skip a room that changed after the snapshot. After a websocket
reconnect, the replayed notification history is ignored except for
notifications newer than the cursor minus two minutes, which were created
while the socket was down. A 429 from the hub or a board waits for `Retry-After` (60 seconds when
absent); other errors retry from 1 second, doubling to 60 seconds.

Known limits:

- Hard-deleted list items are not reported (the hub keeps no tombstone).
- Item events cover creation, stage changes, and changes to the name,
  description, or custom fields. A comment alone only bumps the item's
  `_updatedAt` and is left to the `comment_*` notification. The hub does not
  record who made a normal update, so update events carry no `actor`.
- In poll mode (and in the realtime backstop) a room is read only when its
  subscription changes. The hub does not bump it for edits, deletes,
  reactions, replies in threads you do not follow, or some `@all` messages, so
  those can be missed there. The realtime stream still sees edits.
- One notification poll reads at most 250 notifications; a larger burst logs a
  warning and the older ones are skipped.
- A single response over 8 MiB (for example `chat.syncMessages` for a very
  busy room after a long outage, or `/api/tasks` for a very large board)
  fails that source with `response exceeds 8388608 bytes` until it shrinks.

### Running subscribe as a service

Install a pinned version so the service does not change under you, and keep
the credentials in a file only you can read:

```bash
npm install -g @privos_ai/privos@0.4.1
command -v privos   # the absolute path used below

mkdir -p ~/.config/privos && chmod 700 ~/.config/privos
install -m 600 /dev/null ~/.config/privos/subscribe.env
```

`~/.config/privos/subscribe.env` (plain `KEY=value`, no `export`, no quotes):

```bash
PRIVOS_HUB_URL=https://hub.example.com
PRIVOS_HUB_USER_ID=your-user-id
PRIVOS_HUB_AUTH_TOKEN=your-personal-access-token
GROK_MASTER_WEBHOOK_URL=https://receiver.example.com/privos
GROK_MASTER_WEBHOOK_KEY=your-webhook-key
GROK_MASTER_WEBHOOK_HEADER=x-webhook-key
# only with --projects: td is the default board, any other alias X reads X_URL / X_API_ACCESS_KEY
PRIVOS_SANDBOX_URL=http://127.0.0.1:8556
PRIVOS_SANDBOX_API_KEY=your-sandbox-api-key
TVIBE_URL=https://tvibe.example.com
TVIBE_API_ACCESS_KEY=your-tvibe-api-key
```

Run it once in the foreground first, without `--confirm`, and check the
batches it prints. Then start the service with `--confirm`.

**systemd `--user`.** `~/.config/systemd/user/privos-subscribe.service`:

```ini
[Unit]
Description=privos subscribe (read-only PrivOS event watcher)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=%h/.config/privos/subscribe.env
# use the path printed by `command -v privos`
ExecStart=/usr/local/bin/privos subscribe --confirm --exclude-bots --projects td:PROJECT_ID
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now privos-subscribe
loginctl enable-linger "$USER"     # keep it running after you log out
journalctl --user -u privos-subscribe -f
privos subscribe status
```

If `privos` lives under nvm, `ExecStart` must use that absolute path, and
`privos` must find a matching `node`. Set
`Environment=PATH=/home/you/.nvm/versions/node/v22.x/bin:/usr/bin` in the unit.

**pm2.** pm2 records the environment at start, so load the file first:

```bash
set -a; . ~/.config/privos/subscribe.env; set +a
pm2 start "$(command -v privos)" --name privos-subscribe --kill-timeout 10000 \
  -- subscribe --confirm --exclude-bots --projects td:PROJECT_ID
pm2 save            # pm2 startup (once) restores it after a reboot
pm2 logs privos-subscribe
privos subscribe status
```

After changing the env file, run `pm2 delete privos-subscribe` and start it
again. `pm2 restart` keeps the old environment unless you pass `--update-env`.

Run only one of the two. The state lock already lets only one daemon use a
state file. Exit code `1` after a webhook 4xx means the URL, key, or header is
wrong; fix the env file instead of letting it restart. Both recipes restart
it after 30 s (systemd) or at once (pm2), and the outbox is kept.

`privos hub inbox --since` runs the same hub poll once (messages and in-app
notifications since the given time), prints envelopes, writes
`cursor <ISO time>` to stderr for the next run, and exits. It keeps no state.
The printed cursor already keeps a two-minute overlap, so consecutive runs can
repeat an event; dedupe on `id`.

## Writes

Every mutating command is a dry run unless `--confirm` is present.

A dry run prints JSON to stdout:

```json
{
  "dryRun": true,
  "requests": [
    {
      "method": "POST",
      "url": "http://127.0.0.1:8556/api/projects",
      "headers": { "content-type": "application/json" },
      "omittedHeaderNames": ["x-api-key"],
      "body": { "name": "Alpha", "path": "/work/alpha", "useHookTemplate": false }
    }
  ]
}
```

Credential header names are listed under `omittedHeaderNames`. Their values
are not printed. stderr says that no write was sent. Exit code is 0.
`tasks start` and `tasks answer` still send their `GET` reads in a dry run,
so the preview holds real values.

`--confirm` sends those requests in order. A task update that changes both
text fields and status sends `PATCH /api/tasks/{id}` and then
`PUT /api/tasks/reorder`. A room update that sets both name and topic sends
rename, then `setTopic`. If a later request fails, stdout shows
`{"results": [...], "failed": {...}}` with the responses of the requests
that already went through, and the exit code is 1.

## Starting an agent

`tasks start` starts an agent on a task the way the board UI does. It first
reads `GET /api/tasks/{id}` and `GET /api/tasks/{id}/attempts`. These two
reads are sent even in a dry run. Then, with `--confirm`, it sends:

1. `PUT /api/tasks/reorder` with `status: "in_progress"`, only when the task
   is not already `in_progress`.
2. `PATCH /api/tasks/{id}` with `{"chatInit":true}`, only when `chatInit` is
   not already true.
3. `POST /api/attempts` with `{"taskId","prompt","projectId"}` plus the model
   fields, and the `x-project-id` header.

The prompt is the task description unless `--prompt` is set. `--model` and
`--provider` (or `--llm-provider` with `--model` for a custom catalog model)
pick the runtime; `privos sandbox models list` shows the choices. A task that
has never run should get both, or the board uses its default.

`--effort` takes `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. `ultra`
only matters to Claude runtimes. The board passes effort to the runtime and
does not store it, so attempt reads show `"effort": null`.

`start` refuses while an attempt created in the last 24 hours is still
running, because the board would run a second agent on the same task.
`--force` starts anyway and prints a warning.

`tasks create --start` creates the task in `in_progress` and starts it in the
same command: `POST /api/tasks`, `PATCH /api/tasks/{new id}`, then
`POST /api/attempts`. `--description` is required and becomes the prompt. The
dry run shows `{taskId from response 1}` where the new id goes.

To follow a run:

- `tasks attempts` lists attempts. It is a pure read.
- `tasks conversation` reads one page of the conversation.
- `tasks running` reads the running attempt. The board also cleans up on this
  call: it fails running attempts older than 24 hours and moves an
  `in_progress` task with no running attempt to `in_review`. Use
  `tasks attempts` when you only want to look.
- `tasks question` reads the question the agent is waiting on.

`tasks answer` answers that question over socket.io, as the board UI does: it
emits `question:answer` with the API key as the handshake `auth.token`. Pass
one `--answer` per question, in the order `tasks question` prints them. The
answer counts as delivered when the board acks it, or, when no ack comes
(sandbox mode), once a re-read shows the question gone. The CLI then also
sends `POST /api/attempts/{id}/answer` to save the answer log. That route
requires a `workspaceId` in the body equal to the attempt's. The CLI does not
send one (neither does the board UI), so today the call answers HTTP 400; the
error is printed and ignored. `tasks cancel` is not available for the same
reason.

```bash
privos sandbox models list --format table
privos sandbox tasks start --id TASK_ID --model claude-opus-5-5 --provider claude-cli --effort high
privos sandbox tasks start --id TASK_ID --model claude-opus-5-5 --provider claude-cli --effort high --confirm
privos sandbox tasks question --id TASK_ID
privos sandbox tasks answer --id TASK_ID --answer 'Postgres' --confirm
```

Do not point CI at a live board or hub. The tests use a local mock server.

## Examples

```bash
export PRIVOS_SANDBOX_URL=http://127.0.0.1:8556
export PRIVOS_SANDBOX_API_KEY='your-sandbox-api-key'
privos sandbox projects list
privos sandbox tasks list --project PROJECT_ID --status todo --format table

# prints the POST and does not send it
privos sandbox tasks create --project PROJECT_ID --title 'Write the notes'
# sends it
privos sandbox tasks create --project PROJECT_ID --title 'Write the notes' --confirm
privos sandbox tasks update --id TASK_ID --status in_progress --confirm

export PRIVOS_HUB_URL=http://127.0.0.1:3000
export PRIVOS_HUB_USER_ID='your-user-id'
export PRIVOS_HUB_AUTH_TOKEN='your-auth-token'
privos hub rooms list
privos hub messages list --room ROOM_ID --kind channel
privos hub messages send --room ROOM_ID --text 'hello' --confirm
privos hub lists list --room ROOM_ID
privos hub lists create --room ROOM_ID --name Tasks --confirm
privos hub items create --list LIST_ID --stage STAGE_ID --name Draft --confirm
privos hub items move --id ITEM_ID --stage STAGE_ID --confirm
```

The hub token is a personal access token, or the `authToken` from
`POST /api/v1/login`. This CLI does not ask for a password and does not call
login.

## Further reading

- [Sandbox board API](../api/sandbox.md)
- [Hub API](../api/hub.md)
