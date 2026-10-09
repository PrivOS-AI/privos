# @privos_ai/privos

Operator CLI for a running PrivOS sandbox board and hub. The command is `privos`.

```bash
npm install -g @privos_ai/privos
privos --help
npx @privos_ai/privos version
```

Reads send `GET`. Writes print the request and send nothing unless you pass
`--confirm`. `--dry-run` is the default and cannot be combined with `--confirm`.
`tasks start` reads the task first and sends its writes only with `--confirm`.

Sandbox auth is the `x-api-key` header (`--api-key` or `PRIVOS_SANDBOX_API_KEY`).
Board writes can name who is asking: `--requester ID`, `--requester-name NAME`
and `--requester-kind human|agent` (env `PRIVOS_REQUESTER_ID`,
`PRIVOS_REQUESTER_NAME`, `PRIVOS_REQUESTER_KIND`; flags win). The CLI sends
them as `x-privos-requester-id|name|kind` headers on every board request and as
`auth.requester` on the answer socket, and dry runs print them. Id and name are
up to 64 printable ASCII characters. The board treats the claim as self-declared
unless the key is bound to an identity. `tasks attempts` shows the requester.
Hub auth is `X-User-Id` and `X-Auth-Token` (`--user-id`, `--auth-token`).
An agent bot authenticates with its key instead (`--bot-key` or `PRIVOS_BOT_KEY`,
sent as `Authorization: Bearer`). `privos agents a2a send|members|chain|stop`
uses it for the bot-to-bot protocol; a human token is refused there.

In bot mode (a bot key, or the sandbox egress below) `privos hub lists` and
`privos hub items` call the room routes `/api/v1/internal/rooms/ROOM_ID/...`,
because bot keys cannot use the public `lists.*` and `items.*` routes. `--room`
is required there (default `PRIVOS_ROOM_ID`) and `items create` needs `--name`.
Flags the room routes would silently ignore (`--isolated`, `--archived`,
`--order` on update, `--show-archived-sub-items`, `--parent`, `--sort`,
`--after`, `--include-sub-items`) and the commands `items search`, `items find`
and `items reorder` are refused with a usage error. An agent bot also manages
rooms with `hub rooms create|members|invite|kick|archive` and `update --name`.

Inside an agent VM (`PRIVOS_SANDBOX_MODE=true` with `PROXY_URL` and
`PROXY_TOKEN`) there is no bot key. When no credential of your own is set,
`hub rooms|lists|items|dm` and `agents a2a` send each PrivOS Hub request through
the sandbox proxy (`POST $PROXY_URL/egress`) and the proxy attaches the key. The
hub is `--url`, else `PRIVOS_HUB_URL`, else `https://$PRIVOS_HUB_HOST`. The
proxy decides what the agent may call and a refusal prints its code, for example
`no-binding`. `hub get`, `subscribe` and `sandbox tasks answer` never use it.

`privos hub dm reply --room DM_ROOM_ID --text TEXT` asks the PrivOS Hub to answer
the owner's one-to-one DM in the owner's name, with a "sent by agent" badge. It
works only over the egress, because the hub accepts it only from the agent room
session. The owner's setting decides the outcome: `drafted` waits for the owner
to press Send on the draft card in the agent room, `sent` is posted at once. No
CLI command changes that setting.

`privos subscribe` is a read-only watcher that turns DMs, mentions, in-app
notifications, list items, room files, and board tasks into JSON events on
stdout or a webhook. `privos hub inbox --since` does one poll for cron jobs.

This package is not part of the signed self-hosted install bundle. Full
command and endpoint notes live in the repository:
[docs/cli/README.md](https://github.com/PrivOS-AI/privos/blob/main/docs/cli/README.md).

License: MIT (`LICENSE`). The rest of the PrivOS repository is under the PrivOS Community License 1.0.
