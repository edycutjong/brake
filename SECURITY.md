# Security policy

Brake is a hackathon prototype running against the Aevum testnet (chain 44005). It holds no real funds.

## Reporting a vulnerability

Open a private security advisory on this repository (Security → Report a vulnerability). Please do not open a public issue for anything that could let a third party move or cancel funds.

## Scope

- `src/` Brake contract, `packages/` signer and engine, `apps/web` app.
- Out of scope: the tUSD8 token, Aevum RPC and explorer, the sponsor starter kit.

## Secrets

No keys live in this repository. `gitleaks` runs in CI and in a local pre-push check; its allowlist covers only 20-byte public addresses, so a 32-byte private key is still flagged.
