# Brake — demo and reproduce steps

**Every hash on this page is a live transaction on Aevum testnet 44005** and opens on [explorer-test.qday.info](https://explorer-test.qday.info). The model step is `claude-sonnet-5-5` through the Anthropic API. Amounts are the seed invoices × 0.0001 (`seedScale` in each file) so the faucet can fund them: line 3 is 0.5 tUSD8 for invoice INV-8812.

## Hero: Monday ALLOW, Tuesday email, line 3 stopped (model only), re-issue

Source: `evidence/hero-live.json` (run `run_10a538daf1c0b674`, total 71,109 ms).

| Step | Result | Transaction |
|---|---|---|
| `openRun` by the payer | 4 lines opened, one ERC-8004 Validation request each | [`0x508b19eb027761afb30bec1ffc9ab05594a7962f2d43deb487ec8b53372c329c`](https://explorer-test.qday.info/tx/0x508b19eb027761afb30bec1ffc9ab05594a7962f2d43deb487ec8b53372c329c) |
| Monday review | lines 1-4 ALLOW, 0 rules fired | [`0xf86f81bcec65623a076132b2da6e4427741f853716a608a336b2cee7fc462943`](https://explorer-test.qday.info/tx/0xf86f81bcec65623a076132b2da6e4427741f853716a608a336b2cee7fc462943) |
| Tuesday email E4 delivered, review | line 3 STOP `PAYMENT_DETAIL_CHANGE`, rules fired: none (model-only stop); 7.9 s from the email landing to the stop confirmed (`evidence/bench-rows.json`) | [`0x8832f90c883dd036839236f3871cef55b149675f623058fe789de3871ec5a581`](https://explorer-test.qday.info/tx/0x8832f90c883dd036839236f3871cef55b149675f623058fe789de3871ec5a581) |
| Payday: lines 1, 2, 4 | paid in one Multicall3 batch | [`0x89e469336139f5afd2db1410b686ebe95036c916899acd0c7391a64d4c314d93`](https://explorer-test.qday.info/tx/0x89e469336139f5afd2db1410b686ebe95036c916899acd0c7391a64d4c314d93) |
| Payday: line 3 proof of stop | reverts with `FiatTokenV2: authorization is used or canceled.` | [`0x70f0ce1dccf151c5056e3983bba4be0d673d4425edab2f35d68ccebf119f345e`](https://explorer-test.qday.info/tx/0x70f0ce1dccf151c5056e3983bba4be0d673d4425edab2f35d68ccebf119f345e) |
| Re-issue line 3 to the phone-verified wallet | `Brake.reissue` | [`0xc595d892b0ddfc4d3beb9dc6841f04dbdf7e908662c486cd897cc824fbd35530`](https://explorer-test.qday.info/tx/0xc595d892b0ddfc4d3beb9dc6841f04dbdf7e908662c486cd897cc824fbd35530) |
| Payer `allow` of the re-issued line | `FINANCE_ALLOW` (`REISSUE_PHONE_VERIFIED`) | [`0x726c7d9446526af6d927c07d6b01b1603618b8067425e9bac346f8a4bc6a73df`](https://explorer-test.qday.info/tx/0x726c7d9446526af6d927c07d6b01b1603618b8067425e9bac346f8a4bc6a73df) |
| Payday 2: re-issued line | paid | [`0xe04f2975fb83ab6c9ff8013f6a978472d3990832aa99e2d65a99acbdfbb7f206`](https://explorer-test.qday.info/tx/0xe04f2975fb83ab6c9ff8013f6a978472d3990832aa99e2d65a99acbdfbb7f206) |
| Sweep back to payer | demo funds returned | [`0x51d3e2b65c515316999dacaa82194e8951f4b23bb9e262750fceb5998ad9a271`](https://explorer-test.qday.info/tx/0x51d3e2b65c515316999dacaa82194e8951f4b23bb9e262750fceb5998ad9a271) |

### The model-only stop and its ablation

`evidence/g4/hero-sonnet-5-5.json`, 5 runs each: Monday all lines ALLOW 5/5; Tuesday line 3 STOP 5/5; Tuesday line 3 STOP with 0 rules fired 5/5; Tuesday other lines ALLOW 5/5. With the model stubbed out (`BRAKE_MODEL=none`), line 3 is ALLOWED: a rules-only Brake pays it. The rules do not catch this attack; the model does.

The first live hero attempt failed safe: `claude-sonnet-5-5` rejected the forced `tool_choice` the engine sent (HTTP 400), every review errored, and all four lines were held, with no tUSD8 moved (`evidence/hero-live-model-400-failclosed.json`). The engine now lets the model choose its tool under a strict schema; a missing tool call still holds the line.

## TOO LATE (payment lands first)

`evidence/late-live.json` (17.0 s): the keeper pays line 1 first ([`0x6d32440628c1669f5017041cbfbeac8c261e75121eca8f32cf10a1a264716b9d`](https://explorer-test.qday.info/tx/0x6d32440628c1669f5017041cbfbeac8c261e75121eca8f32cf10a1a264716b9d)), then a double-billing email arrives. The agent decides STOP `DUPLICATE_INVOICE` ([`0xa5da56c4180e3fc1ba17a8f2d87323f8cdf8eec5dc39b8172af071e8c53e01a3`](https://explorer-test.qday.info/tx/0xa5da56c4180e3fc1ba17a8f2d87323f8cdf8eec5dc39b8172af071e8c53e01a3)), the nonce is already used, so Brake records CONSUMED and `StopConsumed` fires; the reconciler reads tUSD8's `AuthorizationUsed` and marks the line TOO LATE with a recovery ticket ("recover from the payee"). No stop budget is charged. Brake does not claw funds back.

## Stop budget (flood)

`evidence/flood-live.json` (70.7 s): three lookalike-sender emails against a 4-line run with `maxStops` 2.

| Step | Result | Transaction |
|---|---|---|
| Email E14 | line 1 STOP `SENDER_LOOKALIKE` | [`0xc30c865e80d60948d52352bbeae3abde4a7ce9b9b4f0ff479f56fe64e48b6646`](https://explorer-test.qday.info/tx/0xc30c865e80d60948d52352bbeae3abde4a7ce9b9b4f0ff479f56fe64e48b6646) |
| Email E15 | line 2 STOP, `StopAlarm` fires at 2 stops | [`0x4d84835728be7f72550411e40828106899ce714dcea977baa5dd78682e4d97a6`](https://explorer-test.qday.info/tx/0x4d84835728be7f72550411e40828106899ce714dcea977baa5dd78682e4d97a6) |
| Email E16 | `StopBudgetExhausted` → line 3 HELD on-chain, escalation ticket for finance | [`0x6e88f1d18478a1c07622f317615f969b25041eb21cbf07d4fa6779656e617f6b`](https://explorer-test.qday.info/tx/0x6e88f1d18478a1c07622f317615f969b25041eb21cbf07d4fa6779656e617f6b) |
| Payday | line 4 paid; line 3 held | [`0x3309930c6a8d6ae103930b6d27f1ea8e0ce130cfae90f0e372a940b613abacde`](https://explorer-test.qday.info/tx/0x3309930c6a8d6ae103930b6d27f1ea8e0ce130cfae90f0e372a940b613abacde) |
| Proofs of stop | lines 1 and 2 revert with the token's error | [`0xb738f9be924fcb1819a0db50c543754229623d2bdf442ede01bd5dcc8c2202b9`](https://explorer-test.qday.info/tx/0xb738f9be924fcb1819a0db50c543754229623d2bdf442ede01bd5dcc8c2202b9) · [`0x70aa1dbf7dae59da0de937378e536e4e3dbc49bca3db21d038a8f75403e4998f`](https://explorer-test.qday.info/tx/0x70aa1dbf7dae59da0de937378e536e4e3dbc49bca3db21d038a8f75403e4998f) |

## Non-custodial run (`sign_local`) — fork only

`evidence/sign-local-fork.json` (anvil fork of 44005, `deployment: fork`; this hash is not on the explorer): the payer's own key signs payment + cancel per line locally, the server receives only signatures and the `openRun` tx hash (`0x45d7a498472b69cd0b97837a5ab8c33b2dba557038ebf42b1a71b21cf4e3c0f3`), and the payer sends `openRun` itself. It also registers its own ERC-8004 identity. Since then the server additionally checks the on-chain run against the signed plan before accepting it. The live re-run needs one more faucet claim.

## Benchmarks (live, claude-sonnet-5-5 through the Anthropic API)

`bench/results.json`; reproduce with `python3 scripts/bench.py` (reads `evidence/bench-rows.json`, which `--export` extracts from the live Postgres plus receipts from the Aevum RPC). The 10 samples are every agent stop that reached the chain in the live runs: hero 1, flood 2, TOO LATE 7 (the TOO LATE demo was run 7 times).

| Metric | Value |
|---|---|
| Email to cancel confirmed, n=10 | p50 4,987 ms · p95 10,093 ms · mean 5,958 · min 4,100 · max 11,919 |
| Gas, median | stop that cancels ~183,000 (n=3) · stop on a used nonce 58,941 (n=7) · allow 302,846 · hold 172,903 · payday 109,418 · reissue 312,789 · financeAllow 300,600 · sweep 87,458 · openRun 376,160 |
| Agent-initiated transfers | 0 |
| Injection suite, held-out (n=6) | rules only 2/6 correct; claude-sonnet-5-5 6/6, 0 false stops, 0 false holds, 0 collateral lines |
| Injection suite, tune (n=19) | rules only 4/19; claude-sonnet-5-5 19/19, 0 false stops, 3 collateral lines |

## Reproduce

Locally, against an anvil fork (no funds needed; hashes are fork-only):

```bash
pnpm install
pnpm fork:up                  # anvil fork of 44005 pinned before the live deploy, deploys Brake and registries
pnpm demo:hero                # hero (needs ANTHROPIC_API_KEY; BRAKE_MODEL=none runs the rules-only ablation)
pnpm demo:late && pnpm demo:flood
pnpm g4                       # 25-email injection suite
python3 scripts/bench.py      # bench/results.json from evidence/bench-rows.json
cd apps/web && python3 e2e/hero_walk.py   # hero through the real UI (about a minute)
```

On the live chain the same scripts run with `DEPLOYMENT=live` and funded testnet wallets in `~/.config/brake/` (tQDAY for gas, tUSD8 for the demo payer). No key is ever read from the repo.

Tests: `forge test` (50), `pnpm --filter brake-signer test` (12), `pnpm --filter @brake/engine test` (69, incl. 3 fast-check properties × 10,000 cases and 21 integration tests that need a local fork and Postgres), 131 in total (`evidence/test-counts.json`).
