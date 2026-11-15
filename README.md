# Brake

Pre-signed stop-payments for stablecoin payment runs on Aevum testnet (chain id 44005).
Finance signs each payment together with its cancellation; a monitor agent can stop a line but cannot move funds.

Work in progress — built during the QDay Aevum Builder Challenge window (from 2026-11-16).

- `src/` — Solidity contracts (Foundry)
- `packages/brake-signer` — EIP-3009 pair signing (payment + cancel)
- `packages/engine` — agent (rules + model + policy), executor, keeper, reconciler, API handlers
- `scripts/kill_test.ts` — G1: proves any caller can submit a payer's pre-signed cancel on tUSD8
- `scripts/demo_hero.ts`, `scripts/demo_edge.ts` — `pnpm demo:hero`, `pnpm demo:late`, `pnpm demo:flood`
- `scripts/g4.ts` + `seed/injection/` — the 25-email injection suite (`pnpm g4`)
- `evidence/` — raw results. **Files named `*-fork.json` come from a local anvil fork of Aevum 44005, not the live
  chain: their tx hashes exist only on that fork and are not on the explorer.** The live re-run is pending testnet
  funding. Model runs in `evidence/g4/` used `claude-sonnet-5-5` through a local CLI adapter (labelled in each file).

License: MIT
