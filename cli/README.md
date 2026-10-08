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

`privos subscribe` is a read-only watcher that turns DMs, mentions, in-app
notifications, list items, room files, and board tasks into JSON events on
stdout or a webhook. `privos hub inbox --since` does one poll for cron jobs.

This package is not part of the signed self-hosted install bundle. Full
command and endpoint notes live in the repository:
[docs/cli/README.md](https://github.com/PrivOS-AI/privos/blob/main/docs/cli/README.md).

License: MIT (`LICENSE`). The rest of the PrivOS repository is under the PrivOS Community License 1.0.
