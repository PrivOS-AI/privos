# PrivOS — self-hosted installer & release bundle

> 🚧 **Pre-release / not yet functional.** This repository will host the signed,
> digest-pinned self-hosted install bundle (`install.sh`, `compose.yml`,
> `versions.json` + minisign signatures) for running privos-hub + privos-sandbox
> on a single Linux host. **Do not `curl | bash` yet** — the bundle is not signed,
> not pinned, and the backing container images/control-plane routes are not public
> or deployed. See `docs/self-hosted-install.md` in the operations repo for the model.

## Intended usage (once released)

```bash
curl -fsSL https://privos.io/install.sh | bash
```

The installer performs preflight + host port-conflict detection, binds only the hub
port publicly (sandbox plane on loopback), verifies a minisign signature on the
bundle, pulls digest-pinned images, and prints a license request code to redeem at
`https://client.privos.io/self-hosted/activate`.
