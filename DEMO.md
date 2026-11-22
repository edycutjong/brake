# Brake — demo and reproduce steps

**Every hash on this page comes from an anvil fork of Aevum testnet 44005 (`deployment: fork`). These hashes exist only on that fork and are not on the explorer.** The live run is pending testnet funding; its hashes will replace these and link to `explorer-test.qday.info`. The fork evidence was recorded before the final contract change of a2a architecture round 1, so the Brake address in `evidence/hero-fork.json` (`0xE92AF9439c95505335C578F7584ADC0B6A35956B`) differs from the current fork deploy in `evidence/deploy-44005-fork.json`. The injection and hero model numbers below were measured at commit `dbb1acb` (the rules-only tune baseline at `2ba7609`), and the latency and gas numbers at `494c2a6`; all predate the a2a architecture changes (agent: unverified findings now HOLD; contract: a hold now also writes an ERC-8004 record), so hold gas in particular is out of date. Re-measure is on the roadmap. The model step used `claude-sonnet-5-5` through a local CLI adapter (labelled in each file).

## Hero: Monday ALLOW, Tuesday email, line 3 stopped (model only), re-issue

Source: `evidence/hero-fork.json` (run `run_001a6364d0ca4997`, 5-line run after re-issue, total 64,442 ms).

| Step | Result | Hash (fork) |
|---|---|---|
| `openRun` by the payer | 4 lines opened, one Validation request each | `0xca3a079dcaef3930656f4a59db853c25422562b54ddd001f5a714ba19449a52e` |
| Monday review | lines 1-4 ALLOW, 0 rules fired | `0x253187ab8c549b06fbfd6a96c9732871dbf504edd262d8f7f12f1ddce276ae3e` |
| Tuesday email E4 delivered, review | line 3 STOP `PAYMENT_DETAIL_CHANGE`, rules fired: none (model-only stop) | `0x5bf466bb58104f0cebc967397611c091b137be81b25664ccd4d46d71bd317db8` |
| Payday: lines 1, 2, 4 | paid in one Multicall3 batch | `0x688f6e8bb369c51c077b748f8f312ceef74542c4b84c4fe4a8735f3304b1ad16` |
| Payday: line 3 proof of stop | reverts with `FiatTokenV2: authorization is used or canceled.` | `0x473af7cc2b2a155c85f0bce3ea9e3f89b759f389ade0e608b4b848e2269c58f3` |
| Re-issue line 3 to the phone-verified wallet, payer `allow` | `FINANCE_ALLOW` (`REISSUE_PHONE_VERIFIED`), decision tx `0xb9ff2024c3…` (full hash in the evidence file) | |
| Payday 2: re-issued line | paid | `0x9cf301c85a55eff7c48fc13a9c1b49e0c09264d1a0feb0fe851d24e56cef41f8` |
| Sweep back to payer | | `0x5ac633bc94c4a28268b6a08f9704064c232bab8e5053af0d8c75e63f3c725580` |

Amounts are seed scale 0.0001 (`seedScale` in the file): line 3 is 0.5 tUSD8 for invoice INV-8812.

### The model-only stop and its ablation

`evidence/g4/hero-sonnet-5-5-cli.json`, 5 runs each: Monday all lines ALLOW 5/5; Tuesday line 3 STOP 5/5; Tuesday line 3 STOP with 0 rules fired 5/5; Tuesday other lines ALLOW 5/5. With the model stubbed out (`BRAKE_MODEL=none`), line 3 is ALLOWED: a rules-only Brake pays it. The rules do not catch this attack; the model does.

## TOO LATE (payment lands first)

`evidence/late-fork.json`: the keeper pays line 1 first (paid tx `0x9da7070bbf3bb0601df23b66cbe86a541a6baa17ffa1f1b6c4bacf676d5958e1`), then a double-billing email arrives. The agent decides STOP `DUPLICATE_INVOICE` (`0x6708c6ab913a9611f73e2ba21e012661e12c9c42d1d929ed0918cdce25bfd674`), the nonce is already used, so the line is CONSUMED, `StopConsumed` fires, and a recovery ticket says to recover from the payee. No stop budget is charged. Brake does not claw funds back.

## Stop budget (flood)

`evidence/flood-fork.json`: three lookalike-sender emails against a 4-line run. Lines 1 and 2 are STOPPED (`SENDER_LOOKALIKE`), `StopAlarm` fires at 2 stops (`0xb207be40440a09ef48e0b21c7bf67bb117f948dde2845f3cde7c772edb1a2bec`), and line 3 is HELD on-chain (`0x4ff1ebca481e54da74402daafaf9c2fcdf0140cd6eb91d95782c72aecf29863f`) with an escalation ticket for finance instead of a third cancel.

## Non-custodial run (`sign_local`)

`evidence/sign-local-fork.json`: the payer's own key signs payment + cancel per line locally, the server receives only signatures and the `openRun` tx hash (`0x45d7a498472b69cd0b97837a5ab8c33b2dba557038ebf42b1a71b21cf4e3c0f3`), and the payer sends `openRun` itself. The payer also registers its own ERC-8004 identity.

## Benchmarks (fork, claude-cli adapter)

`bench/results.json`; reproduce with `python3 scripts/bench.py` (reads `evidence/bench-rows.json`).

| Metric | Value |
|---|---|
| Email to cancel confirmed, n=11 | p50 4,116 ms · p95 6,285 ms · min 3,017 · max 6,553 |
| Median gas | stop 183,023 · allow 1,092,452 · payday 109,418 · reissue 312,767 · financeAllow 300,590 · sweep 236,521 · openRun 1,065,108 |
| Agent-initiated transfers | 0 |
| Injection suite, held-out (n=6) | rules only 2/6 correct; claude-sonnet-5-5 6/6, 0 false stops, 0 false holds, 1 collateral line |
| Injection suite, tune (n=19) | rules only 4/19; claude-sonnet-5-5 19/19, 3 collateral lines |

## Reproduce

```bash
pnpm install
pnpm fork:up                  # local anvil fork of 44005, deploys Brake and registries
pnpm demo:hero                # hero (BRAKE_MODEL=claude-cli, or an Anthropic key)
pnpm demo:late && pnpm demo:flood
pnpm g4                       # 25-email injection suite
python3 scripts/bench.py      # bench/results.json
cd apps/web && python3 e2e/hero_walk.py   # hero through the real UI (about a minute)
```

Tests: `forge test` (50), `pnpm --filter brake-signer test` (12), `pnpm --filter @brake/engine test` (62, incl. 3 fast-check properties × 10,000 cases), 124 in total (`evidence/test-counts.json`).
