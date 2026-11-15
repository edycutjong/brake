# Brake vs its nearest neighbours

Brake gives an agent one power: to cancel (stop) or hold a payment that finance has already signed. It gives the agent no power to pay.

| Neighbour | What it does | Why Brake is different |
|---|---|---|
| x402 (HTTP 402; the `exact` EVM scheme uses EIP-3009 `transferWithAuthorization`, with Permit2 as an alternative) | An agent pays per request with a signed authorization | Brake uses the same token primitive in reverse: the agent can only cancel. The payment is signed by finance, not the agent |
| Safe modules (Zodiac Delay and Roles) | Delay queues a transaction that its owner can skip; Roles scopes which calls a delegate may make | These need a Safe plus the modules, and the canonical Safe 1.4.1 singleton is not deployed on Aevum 44005, so a Safe would be self-deployed first. A delegate allowed to send a payment can still pay. The closest shape is a fully signed Safe transaction waiting to execute: anyone can execute it and only a threshold of owners can kill it by using its nonce first. Brake gives that kill power, alone, to a delegate |
| Spend-cap session keys (Kernel permissions: signer + policies such as spending caps and time locks (QDay wiki)) | A delegate key with caps and expiry | The delegate can still pay up to the cap. A Kernel session restricted to a cancel-only call policy would be the closest smart-account equivalent, but it is not built here: it needs a bundler (none is published for Aevum testnet) and permission modules we did not probe, and it would not by itself carry a per-run stop budget, reason codes and receipts |

## Where Brake is weaker

- It prevents only what it detects (see Limitations in the README). A cap-based design bounds loss by construction; Brake bounds an agent's power, not the fraud that reaches a signed line undetected.
- Its stops depend on tUSD8's FiatToken `cancelAuthorization`; other tokens need the same primitive.
- A server holding signatures is a trust point in demo mode; `scripts/sign_local.ts` shows the authorization-only mode.

Sources: x402 `specs/schemes/exact/scheme_exact_evm.md` (github.com/coinbase/x402); `gnosisguild/zodiac-modifier-delay` and `zodiac-modifier-roles` READMEs; Safe v1.4.1 `Safe.sol`; Kernel permissions (`qday-io/kernel`); Aevum probe of 2026-11-06 for the missing Safe singleton (`eth_getCode` returned no code when probed; probe output not included in this repo) and the absent public bundler endpoint.
