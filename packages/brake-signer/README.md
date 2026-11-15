# brake-signer

Sign a payment run with paired EIP-3009 cancellations, so an agent can stop a payment but never make one.

For each line of a run, `signRun` produces two EIP-712 signatures from the payer: `transferWithAuthorization` (valid only from payday) and the matching `cancelAuthorization`. The agent is given only the cancel signatures; it holds no payment signature and no tokens.

```ts
import { signRun, readTokenDomain } from "brake-signer";
```

Tested against the tUSD8 token on Aevum testnet (chain 44005) via a fork; see the main repository for the evidence and the 12 unit tests. MIT licensed.
