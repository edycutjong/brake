# Aevum DX report (friction log)

What it was like to build a payments product on Aevum testnet (chain id 44005) during the QDay Aevum Builder Challenge window (from 2026-11-16). Each item says what we saw, how we handled it, and what would help the next builder. Facts come from on-chain reads against `https://rpc-test.qday.info`, `evidence/g1-fork.json`, `evidence/finality-observation.json` and the build log; nothing here is a claim about QDay's roadmap.

## What worked well

- **tUSD8 is a real FiatToken with EIP-3009.** `transferWithAuthorization`, `cancelAuthorization`, `authorizationState`, `isBlacklisted` and EIP-2612 all answer, with the canonical typehashes. The domain rebuilds exactly from name `tUSD8`, version `2`, chain id 44005 (`evidence/g1-fork.json`, step 0). Brake's whole mechanism rests on this.
- **Any caller can submit a payer's pre-signed cancel** (an EOA or a contract); we tested both (`test/G1CancelAuthority.t.sol`).
- **Multicall3 and the Arachnid CREATE2 deployer are live**, so a payday batch and deterministic deploys need no extra setup.
- **Archive state is served** (cdk-erigon; state about 100k blocks back at the time), so Foundry fork tests against live tUSD8 state work. We pin `FORK_BLOCK 3252000`.
- **Blocks are fast** (1.012 s per block over 1,000 blocks, 3250865 to 3251865) and gas is 1 gwei, so a stop confirms quickly.
- **Blockscout explorer** gives a place to point judges at.

## Friction

| # | Friction | Impact | How we handled it | Suggestion |
|---|---|---|---|---|
| 1 | The QDay wiki (e.g. https://wiki.qday.info/Knowledge/technical/developer-guide/sdk-code-examples/, crawled November 2026) marks the SDK and CLI pages "Coming Q1 2027", and we found no public bundler or paymaster endpoint for testnet | We could not use the SDK or an ERC-4337 path | Built on raw EIP-3009 signatures, our own contract and viem | A short "what is live today" table at the top of the docs, with addresses |
| 2 | The starter kit recommends ERC-4337 smart accounts, session keys and paymaster gas in tUSD8; Kernel v3.1 factory and EntryPoint v0.7 are live but the bundler is not | Session-key designs cannot be tried end to end | We did not build on Kernel sessions; the comparison says so | Publish a testnet bundler endpoint, or say plainly there is none |
| 3 | No ERC-8004 registry is deployed on 44005, while the starter kit marks ERC-8004 "required" for the Confirmation of Payee track and the rules list it as integration evidence | Every builder deploys their own registries, so identities do not interoperate | We self-deployed the reference registries (`src/ERC8004Bootstrap.sol`, commit `b9e466c`) | Deploy the canonical registries at the canonical addresses |
| 4 | Several canonical contracts are absent: Safe 1.4.1 singleton, Permit2, CreateX, SimpleAccountFactory v0.7 | Safe-based and Permit2-based designs need self-deploys | We avoided them | List which canonical contracts are deployed |
| 5 | The EVM is Shanghai: PUSH0 works, MCOPY and TSTORE are rejected | Default Solidity or Foundry settings that target a newer EVM fail at deploy | Set `evm_version = shanghai` | Say the EVM version in the network page |
| 6 | The faucet gives about 1 tUSD8 per claim (observed: 1.0 in 46 of the faucet contract's last 47 transfers; cooldown unknown), per-address on-chain cooldown | A product that moves realistic amounts needs many claims; payment runs must be scaled down | We use a `seedScale` of 0.0001 for amounts | Document the per-claim amount and cooldown; offer a builder allowance |
| 7 | Finality is slow and not documented: `finalized` (equal to `safe`) lagged `latest` by 4,643 blocks (about 78 min) when observed | "Final" cannot be shown in a demo; reorg depth was not measured | Statuses are shown as provisional for 3 blocks and the finalized tag is reported separately | Document finality and expected reorg depth |
| 8 | Funding wallets (tQDAY for gas, tUSD8) is a manual faucet step | Automated pipelines cannot deploy live; our wallets were unfunded at build time, so all runs are on a fork | Fork-based evidence, labelled, with a scripted live re-run | An API faucet or a builder-account top-up |
| 9 | The tUSD8 issuer can pause or blacklist (FiatToken admin surface present) | A paused token blocks payments and cancels alike | Stated as a limitation | Say who holds these keys on testnet |
| 10 | Docs prose and on-chain reality were not always the same thing, so we could not trust the prose alone | We had to probe the chain to know what exists | We probed the addresses we depend on with `eth_getCode` / `eth_call` (output not included in this repo) | Mark each docs claim live or not live |

## What we would add

1. A "live on testnet" page: addresses for tUSD8, EntryPoint, factories, Multicall3, registries, and what is not live.
2. A testnet bundler and paymaster, or a clear statement that there is none.
3. Canonical ERC-8004 registries.
4. Documented finality, reorg depth and EVM version.
