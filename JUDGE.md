# Brake — for judges

> **We gave the agent the inbox. It still can't move a cent.**

Finance signs each tUSD8 payment line together with its matching `cancelAuthorization`. A monitor agent reads vendor email and can stop or hold a line before payday. It holds no payment signature and 0 tUSD8, so it cannot create a payment or change a payee. The cancel is enforced by the token itself, not by our contract.

The same page is served by the app at `/judge` (no login, no session; `apps/web/app/judge/page.tsx`, pinned by `apps/web/e2e/judge-route.spec.ts`).

## The 30-second path

1. Open the landing page, [brake.edycu.dev](https://brake.edycu.dev/), and press **Replay** on the recorded `pnpm demo:hero · fork` terminal: four lines ALLOW, a vendor email arrives, line 3 is stopped, three lines pay in one batch, line 3's payment reverts with the token's own error.
2. In the app, press **Start a demo run**, then **Play the hero** on the run sheet (no wallet needed; a labelled custodial demo payer signs).
3. Read the one test that pins the claim: [`test_agentHoldsNoSpendingPower_brakeNeverHoldsFunds`](test/Brake.t.sol).
4. Check the evidence on the app's **Verify** page: contracts, tUSD8 observations and an in-browser recompute of each evidence hash.

## Receipts

Measured on an anvil fork of Aevum testnet 44005 (live tUSD8 bytecode and state at block 3,252,000). The live testnet re-run is pending testnet funding; these are fork figures and say so.

| What | Result | Source |
|---|---|---|
| Tests | 126 green: 50 Foundry fork tests, 12 brake-signer, 64 engine | [`evidence/test-counts.json`](evidence/test-counts.json) |
| Property checks | 30,000 generated cases, 0 counterexamples: no model output overrides a rule STOP; a fabricated quote never verifies; unverified findings never ALLOW | [`packages/engine/test/properties.test.ts`](packages/engine/test/properties.test.ts) |
| Model-only stop | line 3 stopped in 5/5 runs with zero rules fired; with the model removed, line 3 pays | [`DEMO.md`](DEMO.md) |
| Injection suite | 19/19 tuning, 6/6 held out with the model; rules alone 4/19 and 2/6 (a 25-email regression suite, not a detection rate) | [`DEMO.md`](DEMO.md) |
| Email → cancel confirmed | p50 4,116 ms · p95 6,285 ms (n=11, fork) | [`bench/results.json`](bench/results.json) |
| Agent-initiated transfers | 0 | [`DEMO.md`](DEMO.md) |

## Reproduce

```bash
pnpm install && forge test          # 50 fork tests against live tUSD8 bytecode
pnpm fork:up                         # anvil fork of 44005, deploys Brake + registries
pnpm demo:hero                       # the hero, with a real model (Anthropic key or claude-cli)
python3 scripts/bench.py             # re-derives p50/p95 from evidence/bench-rows.json
```

The model path is real: with no model configured the engine fails closed and holds every line. The ablation (`BRAKE_MODEL=none`) exists only to show what the rules alone miss.

## Honest limitations

- Brake stops only what its rules or model flag; a missed fraud pays as it would without Brake.
- The cancellation budget binds only the Brake path: anyone holding a raw cancel signature can submit it, so a compromised server could cancel every line (it still could not pay one).
- Demo mode signs with a server-held testnet key; the non-custodial path is the local signing script.
- The tUSD8 issuer holds pause and blacklist powers. Tested on Aevum testnet only.

## Links

- Repo: <https://github.com/edycutjong/brake>
- Landing: <https://brake.edycu.dev/> · Deck: <https://brake.edycu.dev/pitch/>
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Demo and reproduce: [DEMO.md](DEMO.md)
- tUSD8 on the explorer: [0x4565…3483](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483)
