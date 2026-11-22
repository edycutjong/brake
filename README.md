<div align="center">
  <img src="docs/assets/brand/icon-animated.svg" alt="Brake icon: a payment register line stamped STOP" width="144">
  <h1>Brake 🛑</h1>
  <p><em>Pre-signed stop-payments for stablecoin payment runs.</em></p>
  <img src="docs/assets/brand/readme-hero-animated.svg" alt="Brake — a cancel-only agent stops a pre-signed tUSD8 payment line before payday: A red STOP PAYMENT stamp lands across line 3 — 5,000 tUSD8 — with the cancel tx hash as its serial number." width="100%">
  <p>Finance signs each payment together with its cancellation. A monitor agent can stop a line or hold it for finance, and it cannot create a payment or change where one goes.</p>

  <p><strong>Status: live on Aevum testnet 44005.</strong> Contracts deployed, the app runs at <a href="https://app.brake.edycu.dev/">app.brake.edycu.dev</a>, and the hero, TOO LATE and stop-budget runs executed on the live chain with <code>claude-sonnet-5-5</code>. Every hash is in <a href="#%EF%B8%8F-live-deployment">Live Deployment</a>.</p>

  <br/>

  [![For Judges](https://img.shields.io/badge/⚖️_For-Judges-2F4FA2?style=for-the-badge)](JUDGE.md)
  [![Demo Video](https://img.shields.io/badge/▶️_Demo-Video-B3261E?style=for-the-badge)](https://youtu.be/AHshl1gDvHs)
  [![Live App](https://img.shields.io/badge/🚀_Live_App-app.brake.edycu.dev-2E6B4F?style=for-the-badge)](https://app.brake.edycu.dev/)
  [![Landing](https://img.shields.io/badge/🌐_Landing-brake.edycu.dev-06b6d4?style=for-the-badge)](https://brake.edycu.dev/)
  [![Pitch Deck](https://img.shields.io/badge/📊_Pitch-Deck-f59e0b?style=for-the-badge)](https://brake.edycu.dev/pitch/)
  [![QDay Aevum Builder Challenge](https://img.shields.io/badge/DoraHacks-QDay_Aevum_Builder_Challenge-8b5cf6?style=for-the-badge)](https://dorahacks.io/hackathon/qday/detail)
  [![DoraHacks BUIDL](https://img.shields.io/badge/DoraHacks-BUIDL_51649-8b5cf6?style=for-the-badge)](https://dorahacks.io/build/51649)
  [![Track: Invoice Payments](https://img.shields.io/badge/Track-Invoice_Payments-2E6B4F?style=for-the-badge)](https://dorahacks.io/hackathon/qday/detail)
  [![X post](https://img.shields.io/badge/X-Launch_post-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/edycutjong/status/2124558401846067223)
  [![dev.to article](https://img.shields.io/badge/dev.to-Give_your_AI_agent_the_cancel-0A0A0A?style=for-the-badge&logo=devdotto&logoColor=white)](https://dev.to/edycutjong/give-your-ai-agent-the-cancel-not-the-key-3g4)

  <br/>

  ![Solidity](https://img.shields.io/badge/Solidity_0.8-363636?style=flat&logo=solidity&logoColor=white)
  ![Foundry](https://img.shields.io/badge/Foundry-black?style=flat)
  ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
  ![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat&logo=next.js)
  ![viem](https://img.shields.io/badge/viem-1e1e1e?style=flat)
  ![Postgres](https://img.shields.io/badge/Postgres-336791?style=flat&logo=postgresql&logoColor=white)
  [![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)
  [![CI](https://github.com/edycutjong/brake/actions/workflows/ci.yml/badge.svg)](https://github.com/edycutjong/brake/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/edycutjong/brake?sort=semver)](https://github.com/edycutjong/brake/releases/latest)

</div>

---

## 📸 See it in Action

<p align="center">
  <a href="https://app.brake.edycu.dev/"><img src="docs/assets/broll-live.gif" alt="Live b-roll from app.brake.edycu.dev on Aevum testnet 44005: the For-judges headline, then the run sheet where line 3 carries a STOP PAYMENT stamp with cancel tx 0x8832…a581, the agent desk's Line 3 STOP card with rules fired: none, the payday receipt where line 3's replay reverts with FiatTokenV2: authorization is used or canceled, and the Verify page reading the agent's tUSD8 allowance and balance as 0." width="100%"></a>
</p>

<sub>Recorded from the live app (read-only view of run <code>run_10a538daf1c0b674</code> on Aevum testnet 44005); every hash shown is on the explorer. Full walkthrough with voiceover: <a href="https://youtu.be/AHshl1gDvHs">demo video</a>.</sub>

These screens were captured on a local anvil fork of Aevum 44005 during the build (each is labelled). The same flow has since run on the live chain: the live hero took 71.1 s end to end (`evidence/hero-live.json`), and the app at [app.brake.edycu.dev](https://app.brake.edycu.dev/) shows that run with explorer links.

| Run sheet (Monday: every line ALLOWED) | Run sheet (Tuesday: line 3 STOPPED) |
|---|---|
| ![Run sheet, Monday](docs/screenshots/run-sheet-monday.png) | ![Run sheet, line 3 stopped](docs/screenshots/run-sheet-stopped.png) |

| Agent desk (decision cards, model-only wording) | Payday and receipts (proof-of-stop revert) |
|---|---|
| ![Agent desk](docs/screenshots/agent-desk.png) | ![Payday](docs/screenshots/payday.png) |

| TOO LATE (payment landed first, recovery ticket) | Verify (recompute evidence in the browser) |
|---|---|
| ![Too late](docs/screenshots/edge-too-late.png) | ![Verify](docs/screenshots/verify.png) |

## 💡 The Problem & Solution

### The Problem

Finance teams approve vendor payments days before payday, and things change in between: an invoice is disputed, goods do not arrive, or a "we changed our bank details" email turns out to be fraud. Business email compromise drew $2,770,151,146 in reported losses across 21,442 complaints to the FBI's IC3 in 2024 ([FBI IC3 2024 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf), complaint and loss tables). On a stablecoin chain the payer cannot recall a payment once it lands. Today, stopping a scheduled crypto payment needs the key holder online, and giving a bot a key that can pay means a hijacked bot can pay.

### The Solution

For every line of a payment run, finance signs two EIP-712 messages once: the payment (`transferWithAuthorization`, valid only from payday) and its matching `cancelAuthorization`. A monitor agent reads the untrusted inputs (vendor email, the vendor master's change history, the invoice and dispute ledger, tUSD8's own `isBlacklisted`) and records a decision per line on-chain. Its only powers are `allow`, `hold` and `stop`:

- **Stop:** the `Brake` contract submits the pre-signed cancel to tUSD8 with a reason code and an evidence hash, and records the decision in an ERC-8004 Validation Registry. The paid-line attempt on payday then reverts with the token's own error (`FiatTokenV2: authorization is used or canceled.`).
- **Hold:** Brake's keeper will not pay the line until finance decides, and the hold is recorded on-chain; one payer `allow` releases it without re-signing. A hold is not a token-level block: the signed payment stays valid at tUSD8 until `validBefore`, so a confirmed risk is a `stop`.
- **Re-issue:** finance replaces a falsely stopped line in one click (demo mode; in a non-custodial run the server holds no payer key and refuses, so the payer would call `Brake.reissue` from their own wallet, which `scripts/sign_local.ts` does not do yet).

The agent holds 0 tUSD8 and no allowance (checked on `/verify`). A hijacked agent can delay a payment; it cannot create one or change where one goes. Brake does not claim to stop BEC in general. It stops a signed line when a signal arrives before payday (see [Honest limits](#honest-limits-12)).

Nearest neighbours and why Brake differs: [docs/COMPARISON.md](docs/COMPARISON.md).

## 🏗️ Architecture & Tech Stack

<p align="center">
  <a href="https://brake.edycu.dev/architecture.html"><img src="docs/assets/architecture.png" alt="Brake architecture: finance signs a payment slip and a stop slip per line with the same EIP-3009 nonce; the agent reads vendor email through a six-step pipeline and can only return STOP, HOLD or ALLOW; the executor fires Brake.stop, which cancels the nonce at tUSD8; on payday the keeper's Multicall3 batch pays lines 1, 2 and 4 while line 3 reverts." width="100%"></a>
</p>

<sub>Full-size page: <a href="https://brake.edycu.dev/architecture.html">brake.edycu.dev/architecture.html</a> (source: <a href="docs/architecture.html">docs/architecture.html</a>).</sub>

<details>
<summary><b>Component graph (Mermaid)</b>: click to expand</summary>

```mermaid
flowchart LR
  subgraph Web[apps/web · Next.js 16]
    UI[Run sheet · Agent desk · Payday · Verify]
    API[catch-all /api route → engine createApi]
  end
  subgraph Engine[packages/engine]
    AG[agent: rules + model + policy]
    EX[executor: holds cancel sigs]
    KP[keeper: holds payment sigs]
    RC[reconciler: log scan]
  end
  DB[(Postgres)]
  LLM[Anthropic API]
  subgraph Aevum[Aevum testnet 44005 · live]
    BR[Brake.sol]
    VR[ERC-8004 Validation]
    T[tUSD8]
    MC[Multicall3]
  end
  UI --> API --> AG -->|messages as data| LLM
  AG --> EX -->|stop + cancel sig| BR -->|cancelAuthorization| T
  BR --> VR
  KP -->|aggregate3 transferWithAuthorization| MC --> T
  RC --> DB
```

</details>

Full component and sequence diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).

| Layer | Choice |
|---|---|
| Chain | Aevum testnet, chain id 44005, RPC `https://rpc-test.qday.info`, explorer `https://explorer-test.qday.info` |
| Token | tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`, a FiatToken (EIP-3009, EIP-2612) |
| Contracts | Solidity 0.8, Foundry, OpenZeppelin; `src/Brake.sol`, `src/ERC8004Bootstrap.sol` |
| Signing | `packages/brake-signer` (viem), pairs payment + cancel |
| Engine | `packages/engine` (TypeScript): agent, executor, keeper, reconciler, API handlers |
| App | Next.js 16 on Vercel (live at app.brake.edycu.dev), Neon Postgres |
| Model | `claude-sonnet-5-5`, one strict-schema tool (`record_findings`, `tool_choice: auto`; a missing tool call holds the line), no temperature parameter set, no pay tool, no signatures |
| Batching | Multicall3 `aggregate3` for the payday batch |

## 🏆 QDay Aevum Integration

Brake builds on what is live on Aevum 44005 (checked with `eth_getCode` / `eth_call` against `https://rpc-test.qday.info`), and does not use what is not live (`@qday-io/sdk`, PQ precompiles, a public bundler or paymaster).

- **tUSD8 EIP-3009** `transferWithAuthorization`, `cancelAuthorization`, `authorizationState`, plus `isBlacklisted`: the whole stop mechanism. G1 proves any caller, an EOA or a contract, can submit a payer's pre-signed cancel (`test/G1CancelAuthority.t.sol`, 7 tests; live on 44005 in `evidence/g1.json`: cancel from an unrelated EOA [`0x8cb8d550…30c2`](https://explorer-test.qday.info/tx/0x8cb8d550f03616e14ef00682022dd20a4ade46e090c8466766d6799dc98330c2), cancel through a contract [`0x50c5cfcc…2df5`](https://explorer-test.qday.info/tx/0x50c5cfcc0d470f71ab91b75cbea227cc820df0c19543bd919e4d293fd2c12df5), the cancelled payment then reverts [`0x07dbb275…bb7d`](https://explorer-test.qday.info/tx/0x07dbb27599ac8615360e0e52e04475ec2193c334c330e76ffd2b6dd52529bb7d)).
- **Multicall3** `aggregate3`: one payday transaction pays N lines.
- **ERC-8004**: the canonical ERC-8004 Identity and Reputation addresses have no code on 44005 (`evidence/live-chain-probe.json`), so Brake self-deploys the reference registries (`src/ERC8004Bootstrap.sol`, reference commit `b9e466c`, answers in `evidence/g2a.json`). `openRun` binds the agent's identity (`agentId`); each decision writes a Validation Registry response (ALLOW 100, HOLD 50, STOP 0).
- **Arachnid CREATE2** deployer for deterministic addresses.

### Rubric map

| Criterion | Where in Brake |
|---|---|
| Scoped session keys, least privilege | A contract-level grant, not a Kernel session key: per run, three functions (`allow`, `hold`, `stop`), expiry (`agentExpiry`, a payer-chosen timestamp; the engine sets it to payday + 48 h), a stop budget, `revokeAgent`, `agentId`-bound. No spend exists to scope: the agent's cap is zero |
| Spending limits | Agent spend is zero by construction; its stops are capped by `maxStops` |
| Instant revocation | `revokeAgent` (Brake-routed stops; scope in limitations) |
| Identity primitives | ERC-8004 Identity `agentId` bound in `openRun`; Validation response per decision |
| Transaction review and approval | Run sheet review before signing; HELD lines and escalations wait for finance (keeper-side hold) |
| Verifiable on-chain audit trail | `LineStopped` / `LineAllowed` / `LineHeld` with reason and evidence hash; recompute box on `/verify` |
| Retries, async confirmations, edge cases | Idempotent stop, per-EOA nonce queue, receipt retry, CONSUMED → TOO LATE / EXTERNALLY CANCELLED |
| Prompt injection | The model has no pay tool and no signatures; rules can only STOP; verbatim-quote check; 25-email injection suite |

## ⛓️ Live Deployment

**No wallet needed to check any of this:** every link below is a read-only explorer page, and [app.brake.edycu.dev/verify](https://app.brake.edycu.dev/verify) reads the same contracts and events from the chain in your browser.

| Contract | Address on Aevum testnet 44005 | Source |
|---|---|---|
| Brake | [`0xbDB614Ce4f1319f78DBF3856070092Cc83405B59`](https://explorer-test.qday.info/address/0xbDB614Ce4f1319f78DBF3856070092Cc83405B59) | source verified on the explorer (`evidence/explorer-verification.json`) |
| ERC-8004 IdentityRegistry (proxy) | [`0xe1326D6e2B1D3Efa43a38bC95A8d87b50c4CEa2e`](https://explorer-test.qday.info/address/0xe1326D6e2B1D3Efa43a38bC95A8d87b50c4CEa2e) | proxy and implementation [`0x9bd1d89081D9cEC5D16BBd239e852A382A8944a8`](https://explorer-test.qday.info/address/0x9bd1d89081D9cEC5D16BBd239e852A382A8944a8) source verified |
| ERC-8004 ValidationRegistry (proxy) | [`0xC4496D7B66f2b768Ea61922A9Fe923f272007b83`](https://explorer-test.qday.info/address/0xC4496D7B66f2b768Ea61922A9Fe923f272007b83) | proxy and implementation [`0x1bE269891c41D728aC4B94fd528eb0A70F346E48`](https://explorer-test.qday.info/address/0x1bE269891c41D728aC4B94fd528eb0A70F346E48) source verified |
| tUSD8 (Circle FiatToken v2.2 clone, not ours) | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) | live on 44005 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | live on 44005 |

Agent identity: ERC-8004 agentId 0, owned by the demo payer; deployed at block 3,821,162 (`evidence/deploy-44005-live.json`).

**Live runs** (model `claude-sonnet-5-5` through the Anthropic API; amounts are the seed invoices × 0.0001 so the faucet can fund them):

| Run | What happened on chain | Transactions |
|---|---|---|
| Hero (`evidence/hero-live.json`, 71.1 s) | Monday ALLOW ×4 → Tuesday's email → the model alone stops line 3 (rules fired: none) → lines 1, 2, 4 paid in one Multicall3 batch → line 3's replay reverts `FiatTokenV2: authorization is used or canceled` → finance re-issues line 3 to the phone-verified wallet and it pays | allow [`0xf86f81bc…2943`](https://explorer-test.qday.info/tx/0xf86f81bcec65623a076132b2da6e4427741f853716a608a336b2cee7fc462943) · stop [`0x8832f90c…a581`](https://explorer-test.qday.info/tx/0x8832f90c883dd036839236f3871cef55b149675f623058fe789de3871ec5a581) · batch [`0x89e46933…4d93`](https://explorer-test.qday.info/tx/0x89e469336139f5afd2db1410b686ebe95036c916899acd0c7391a64d4c314d93) · revert [`0x70f0ce1d…345e`](https://explorer-test.qday.info/tx/0x70f0ce1dccf151c5056e3983bba4be0d673d4425edab2f35d68ccebf119f345e) · re-issue paid [`0xe04f2975…f206`](https://explorer-test.qday.info/tx/0xe04f2975fb83ab6c9ff8013f6a978472d3990832aa99e2d65a99acbdfbb7f206) |
| TOO LATE (`evidence/late-live.json`, 17.0 s) | the keeper pays first, then the "double billed" email arrives; the agent's stop lands on a used nonce, Brake records CONSUMED, the reconciler reads `AuthorizationUsed` and marks TOO LATE with a recovery ticket. The agent never claims a stop it did not make | payment [`0x6d324406…6b9d`](https://explorer-test.qday.info/tx/0x6d32440628c1669f5017041cbfbeac8c261e75121eca8f32cf10a1a264716b9d) · stop → CONSUMED [`0xa5da56c4…01a3`](https://explorer-test.qday.info/tx/0xa5da56c4180e3fc1ba17a8f2d87323f8cdf8eec5dc39b8172af071e8c53e01a3) |
| Stop budget (`evidence/flood-live.json`, 70.7 s) | three lookalike "goods not received" emails: stop #1, stop #2 fires `StopAlarm`, attempt #3 hits `StopBudgetExhausted` and becomes an on-chain HOLD with an escalation ticket; payday pays line 4 and proves both stops | stop #1 [`0xc30c865e…6646`](https://explorer-test.qday.info/tx/0xc30c865e80d60948d52352bbeae3abde4a7ce9b9b4f0ff479f56fe64e48b6646) · stop #2 + alarm [`0x4d848357…97a6`](https://explorer-test.qday.info/tx/0x4d84835728be7f72550411e40828106899ce714dcea977baa5dd78682e4d97a6) · budget hold [`0x6e88f1d1…7f6b`](https://explorer-test.qday.info/tx/0x6e88f1d18478a1c07622f317615f969b25041eb21cbf07d4fa6779656e617f6b) · payday [`0x3309930c…acde`](https://explorer-test.qday.info/tx/0x3309930c6a8d6ae103930b6d27f1ea8e0ce130cfae90f0e372a940b613abacde) |
| G1 kill test (`evidence/g1.json`) | the token itself enforces the cancel: any caller can submit the payer's pre-signed cancel, and the paired payment then reverts | see the tUSD8 bullet in the sponsor section |

Still fork-only: the authorization-only `sign_local.ts` run (`evidence/sign-local-fork.json`) and the forge suite, which pins tUSD8 state at block 3,252,000 so CI is reproducible. Fork files are labelled `deployment: fork` (or `mode: fork`) and their hashes never appear on the explorer.

## 📊 Engineering Rigor

| Metric | Value | Source |
|---|---|---|
| Tests | 131 passing: forge 50 + brake-signer 12 + engine 69 | `evidence/test-counts.json` |
| Property checks (fast-check) | 3 properties × 10,000 generated cases = 30,000, 0 counterexamples | `packages/engine/test/properties.test.ts` |
| E2E (Playwright) | 24 passing: `/judge` with no credentials, no-key smoke, responsive 375/768/1440, desktop + Pixel 7 | `apps/web/e2e/*.spec.ts` |
| Forge tests run against | tUSD8 state at fork block 3252000 | `evidence/test-counts.json` |
| Latency, email to agent stop confirmed (live, n=10) | p50 4,987 ms, p95 10,093 ms over every live agent stop: 3 that cancelled a payment (4,404, 6,770 and 7,861 ms) and 7 TOO LATE stops that landed on an already-used nonce. With n=10, p95 sits near the slowest run (11.9 s) | `bench/results.json`, rows in `evidence/bench-rows.json` |
| Gas, live median | stop that cancels ~183,000 (n=3) · stop on an already-used nonce 58,941 (n=7, TOO LATE) · allow 302,846 · payday 109,418 · reissue 312,789 (n=1) · openRun 376,160. allow, payday and openRun medians are dominated by 1-line TOO LATE runs; the hero's 4-line openRun used 1,065,120, its 4-line allow 1,092,474 and its 3-line payday 238,112 | `evidence/bench-rows.json` (receipts from the Aevum RPC) |
| Agent-initiated transfers | 0 | `bench/results.json` |
| Hero, model-only stop (5 runs) | line 3 STOP 5/5 with 0 rules fired; Monday ALLOW all lines 5/5; with the model stubbed, line 3 is ALLOWED | `evidence/g4/hero-sonnet-5-5.json` |
| Injection suite (25 emails) | with the model: tune 19/19, held-out 6/6, 0 missed, 0 false stops; rules alone: 4/19 and 2/6 | `evidence/g4/{tune,holdout}-{sonnet-5-5,none}.json` |

The model figures come from `claude-sonnet-5-5` through the Anthropic API (the production path). Earlier runs through a local CLI adapter are kept beside them (`*-sonnet-5-5-cli.json`) and say so in each file. This is a 25-email regression suite, not a detection rate.

### Injection suite (25 emails, G4)

| Split | Model | n | Correct | Missed stops | False stops | False holds | Collateral stops |
|---|---|---|---|---|---|---|---|
| Tune | rules only | 19 | 4 | 8 | 0 | 0 | 0 |
| Tune | claude-sonnet-5-5 | 19 | 19 | 0 | 0 | 0 | 3 |
| Held-out | rules only | 6 | 2 | 2 | 0 | 0 | 0 |
| Held-out | claude-sonnet-5-5 | 6 | 6 | 0 | 0 | 0 | 0 |

n is small (25), so read these as a regression suite, not a detection rate. The rules-only rows' other misses are HOLD-labelled injection emails that rules alone leave unflagged: 7 in the tune split, 2 held out (`evidence/g4/*-none.json`). "Collateral" lines are emails that name the fraud wallet, which is also the on-file payee of another line, so that line stops too; each is reported per row. The 6 held-out emails were committed before tuning (`680805f`). Source: `bench/results.json`, `evidence/g4/`.

### Attacks defeated

| Control | Why it is load-bearing | Test |
|---|---|---|
| The agent cannot pay | `agentHoldsNoSpendingPower_brakeNeverHoldsFunds` | `test/Brake.t.sol:256` |
| Only the grant holder acts; revoked and expired agents are refused | stranger, revoked, expired | `test/Brake.t.sol:233` |
| No model output can turn a rule STOP into ALLOW or HOLD | invariant I4 | `packages/engine/test/agent.test.ts:229` |
| … for any generated model output (10,000 cases) | property: rules are consulted first | `packages/engine/test/properties.test.ts` |
| A fabricated quote never verifies (10,000 cases) | property: quotes must be verbatim | `packages/engine/test/properties.test.ts` |
| Unverified findings never ALLOW (10,000 cases) | property: fail-closed | `packages/engine/test/properties.test.ts` |
| Injection alone HOLDs, never ALLOWs | | `packages/engine/test/agent.test.ts:244` |
| A paraphrased or misattributed model quote is dropped | verbatim quote check | `packages/engine/test/agent.test.ts:194` |
| Email text cannot forge the prompt's data tags | | `packages/engine/test/agent.test.ts:123` |
| Model failure never becomes ALLOW | rules still STOP; the rest stay undecided | `packages/engine/test/agent.test.ts:107` |
| Stop is idempotent and charges the budget once | | `test/Brake.t.sol:157` |
| Payment lands first: TOO LATE, no budget charged | | `test/BrakeLifecycle.t.sol:228` |
| A hostile registry cannot re-enter during the receipt | | `test/BrakeLifecycle.t.sol:258` |
| A failing registry never blocks a stop | receipt retried later | `test/BrakeReceipts.t.sol:15` |

### Honest limits (12)

1. **Brake prevents only what it detects.** A wrong stop costs a late payment (re-issue). A fraud that neither the rules nor the model flag, such as a BEC email from the vendor's real, compromised mailbox with no payee change on file, pays as it would without Brake. A prompt injection can suppress a stop that only the model would have made; it cannot create a payment or change a payee.
2. **Brake trusts the vendor file's recorded verifications.** It cannot prove a past "phone-verified" change used an independent number.
3. **Brake acts only on what arrives before payday.** Had the attacker stayed silent, line 3 in the hero would have paid.
4. **If a payment was already redeemed,** Brake reports TOO LATE and opens a recovery ticket. It cannot claw funds back.
5. **The stop budget binds only the Brake path.** Anyone holding a raw cancel signature can submit it to tUSD8 directly, so a compromised server can cancel every line (a delayed run). The same server holds the encrypted payment signatures, so a compromise can also pay an undecided line to its signed payee without review; it cannot change payee or amount. A hijacked agent can cancel up to `maxStops` lines per run (set per run by the payer; the demo scenarios use 2, 1 and 2) and can HOLD any line, so it can delay a run. Each stop is re-issuable and each hold is released by one payer `allow`.
6. **A HELD line with finance away** stays unpaid until `validBefore` (payday + 48 h), then shows EXPIRED and needs a re-signed line.
7. **Revocation scope.** `revokeAgent` blocks Brake-routed stops at once; signatures already issued stay valid (cancels until the line is consumed, payments until `validBefore`).
8. **Demo mode is custodial:** the server holds a testnet demo payer key. The authorization-only mode is `scripts/sign_local.ts` (your key signs, the server holds only signed authorizations; ran on the fork in `evidence/sign-local-fork.json`).
9. **Finality.** Statuses are provisional for `CONFIRMATIONS` blocks (3). The `finalized` tag lagged `latest` by 4,643 blocks (about 78 min) when observed (`evidence/finality-observation.json`); reorg depth on Aevum was not measured.
10. **Privacy:** vendor email text goes to the Anthropic API for the model step; only hashes go on-chain.
11. Tested on Aevum's tUSD8 only; the mechanism should port to other FiatToken-v2 chains. The issuer can pause or blacklist tUSD8, which blocks both payments and cancels.
12. Not built: IMAP inbox, Docker image, npm publish of `brake-signer` (human step).

## 🚀 Getting Started

### Prerequisites

Node 22 or newer, pnpm 10, Foundry, Postgres, and `anvil` for a local fork. No secret lives in the repo: local runs read `~/.config/brake/` (wallet keys, app env, model key).

### Installation

```bash
pnpm install
pnpm fork:up          # anvil fork of Aevum 44005 + deploy
pnpm demo:hero        # the hero run end to end (needs a model: BRAKE_MODEL=claude-cli or an Anthropic key)
```

Environment variables (names only; values never committed):

| Variable | Purpose |
|---|---|
| `DEPLOYMENT` | `fork` or `live` |
| `BRAKE_MODEL` | `anthropic`, `claude-cli` (dev adapter) or `none` (ablation) |
| `ANTHROPIC_API_KEY` | model step (live) |
| `DATABASE_URL`, `DATABASE_URL_TEST` | Postgres |
| `DEMO_PAYER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY` | demo payer, monitor agent, keeper wallets (agent holds no funds) |
| `AGENT_ADDRESS` | the agent's address, bound to its ERC-8004 identity |
| `SIG_ENC_KEY` | encrypts stored signatures at rest |
| `PAYEES_MNEMONIC` | seed vendor payee wallets |
| `CRON_SECRET` | authenticates the backstop tick |
| `PUBLIC_URL` | public base URL |
| `DAILY_SPEND_CAP_UNITS` | demo payer's daily cap |
| `DEPLOY_BLOCK`, `TX_STUCK_AFTER_S` | reconciler start block, stuck-tx replacement delay |

`scripts/vercel_env.sh` pushes them to Vercel through stdin without echoing.

### API reference

Mounted at `/api/*` through one catch-all route (`apps/web/app/api/[...path]/route.ts`, handlers in `packages/engine/src/api.ts`):

| Route | Purpose |
|---|---|
| `GET /api/plan`, `POST /api/runs` | wallet mode: get the lines to sign, then create the run from signatures (server recovers each signer) |
| `POST /api/runs/:id/open`, `/opened` | open the run on-chain, confirm the `openRun` receipt |
| `GET /api/runs/:id` | run state and lines |
| `POST /api/runs/:id/inbox`, `GET` same | add or list vendor messages |
| `POST /api/runs/:id/review` | manually enqueue a review (budgeted; reviews also run on every inbox delivery) |
| `POST /api/runs/:id/lines/:idx/decide`, `/reissue` | finance decision on a HELD line; re-issue a stopped line |
| `POST /api/runs/:id/revoke` | revoke the agent for the run |
| `POST /api/runs/:id/payday` | keeper: pay ALLOWED lines (Multicall3), proof-of-stop txs, HELD tickets; idempotent |
| `GET /api/evidence/:hash` | evidence bundle for a decision hash |
| `GET`/`POST /api/keeper/tick` | backstop tick (authenticated by `CRON_SECRET`) |
| `GET /api/verify/events`, `/api/verify/observations`, `/api/health` | on-chain event feed, tUSD8 observations, health |

Contract surface (`src/Brake.sol`): `openRun`, `allow`, `hold`, `stop`, `financeStop`, `reissue`, `revokeAgent`, `retryReceipt`, and the views `lineOf`, `lineDetail`, `runOf`, `requestHashOf`, `isStopReason`, `isHoldReason`.

## 🧪 Testing & CI

```bash
forge test                                   # 50 fork tests (tUSD8 state at block 3252000)
pnpm --filter brake-signer test              # 12
pnpm --filter @brake/engine test             # 69 incl. 3 fast-check properties (integration tests skip without a fork and local keys)
pnpm g4                                      # the 25-email injection suite
python3 scripts/bench.py                     # reproduce bench/results.json from evidence/bench-rows.json
python3 apps/web/e2e/hero_walk.py            # the hero through the real UI (needs pnpm fork:up)
pnpm e2e                                     # Playwright: /judge no-auth, smoke, responsive
pnpm lighthouse                              # Lighthouse CI: app + landing/deck
pnpm ci                                      # fmt + forge + typecheck + tests + build
```

**6-stage pipeline** (`.github/workflows/ci.yml`): Quality → Security → Build → E2E → Performance → Deploy gate.

| Stage | Gate |
|---|---|
| 1 · Quality | `forge fmt --check`, `forge build --sizes`, 50 fork tests · typecheck + unit/property tests on node 22 (and 24 on pushes to main) |
| 2 · Security | gitleaks over full history · `pnpm audit --prod` · licence check (no GPL-3.0/AGPL-3.0) |
| 3 · Build | Next.js production build · bundle budget (warn 1,500 KB, fail 2,000 KB) · `brake-signer` pack |
| 4 · E2E | Playwright on desktop Chrome + Pixel 7 |
| 5 · Performance | Lighthouse CI on the app and the landing/deck; accessibility ≥ 0.9 is a hard gate |
| 6 · Deploy gate | main only, after every stage above |

Also: CodeQL (`codeql.yml`), Dependabot (grouped, monthly), and `release.yml`, which tags a semantic version from Angular-convention commits (`feat:` minor, `fix:` patch). The 21 engine integration tests need a local anvil fork and keys, so CI runs them as skipped; they pass locally with `pnpm fork:up` (`evidence/test-counts.json`).

## 📁 Project Structure

```
src/                  Brake.sol, ERC8004Bootstrap.sol, interfaces
test/                 forge fork tests (G1 cancel authority, lifecycle, receipts, ERC-8004)
packages/brake-signer EIP-3009 pair signing, openRun / stopLine / lineStatus / verifyEvidence
packages/engine       agent, executor, keeper, reconciler, API handlers, schema.sql
apps/web              Next.js app: run sheet, agent desk, payday, verify, Play-the-hero
scripts/              kill_test, demo_hero / demo_edge, g4, bench, sign_local, fork_up
seed/                 vendors, invoices, runs, inbox, 25 injection emails + labels
evidence/             raw results; *-fork.json come from a fork, not the live chain
docs/                 DX-REPORT.md, COMPARISON.md, screenshots
```

## 🗺️ Roadmap

- [x] G1: any caller can submit a payer's pre-signed cancel on tUSD8 (live on 44005)
- [x] Brake contract, ERC-8004 receipts, re-issue, stop budget, TOO LATE
- [x] Agent: rules, model, policy, verbatim-quote check; injection suite
- [x] Product app and guided hero walk
- [x] `sign_local.ts` authorization-only run (fork)
- [x] Live deploy on 44005, live hero / TOO LATE / stop-budget runs, live bench
- [ ] `sign_local.ts` authorization-only run on the live chain (needs one more faucet claim)
- [ ] `brake-signer` npm publish (human step)

## 📽️ Demo Materials

Demo video (3 min): https://youtu.be/AHshl1gDvHs. Reproduce steps with the live hashes: [DEMO.md](DEMO.md). Friction log for QDay: [docs/DX-REPORT.md](docs/DX-REPORT.md). Landing page: https://brake.edycu.dev/ ([source](docs/index.html)). Pitch deck: https://brake.edycu.dev/pitch/ ([source](docs/pitch/index.html)). One page for judges: [JUDGE.md](JUDGE.md) (also `/judge` in the app). Live app: https://app.brake.edycu.dev/ (Aevum testnet 44005).

## 📄 License

MIT, see [LICENSE](LICENSE).

## 🙏 Acknowledgments

Circle's FiatToken (EIP-3009) design, the ERC-8004 reference registries (`erc-8004/erc-8004-contracts`, commit `b9e466c`), and the QDay team's Aevum testnet.
