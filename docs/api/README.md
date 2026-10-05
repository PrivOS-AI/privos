# API notes for the privos CLI

These notes describe the HTTP calls the `privos` CLI makes. They are the
companion to [the CLI guide](../cli/README.md), not a full product API
reference.

| Surface | Auth | CLI |
|---|---|---|
| [Sandbox board](sandbox.md) | `x-api-key` | `privos sandbox` |
| [Hub](hub.md) | `X-User-Id` + `X-Auth-Token` | `privos hub` |

The official hub overview is
[API Overview](https://docs.privos.ai/guide/developer/api-overview.html).
The board is a separate service (loopback port 8556 on a default self-hosted
install).
