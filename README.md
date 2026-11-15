# Brake

Pre-signed stop-payments for stablecoin payment runs on Aevum testnet (chain id 44005).
Finance signs each payment together with its cancellation; a monitor agent can stop a line but cannot move funds.

Work in progress — built during the QDay Aevum Builder Challenge window (from 2026-11-16).

- `src/` — Solidity contracts (Foundry)
- `packages/brake-signer` — EIP-3009 pair signing (payment + cancel)
- `scripts/kill_test.ts` — G1: proves any caller can submit a payer's pre-signed cancel on tUSD8
- `evidence/` — raw results of on-chain checks

License: MIT
