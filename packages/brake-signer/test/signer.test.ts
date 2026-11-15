import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AEVUM_TESTNET_CHAIN_ID,
  CANCEL_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  TUSD8_ADDRESS,
  domainSeparator,
  randomNonce,
  signPair,
  signRun,
  signTransferAuthorization,
  toTypedDataDomain,
  type TokenDomain,
} from "../src/index.js";

// test-only key (well-known anvil account #1) — never funded on Aevum
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const domain: TokenDomain = { name: "tUSD8", version: "2", chainId: AEVUM_TESTNET_CHAIN_ID, verifyingContract: TUSD8_ADDRESS };
const payee = "0x000000000000000000000000000000000000bEEF" as const;

describe("brake-signer", () => {
  it("rebuilds tUSD8's live DOMAIN_SEPARATOR from name/version/chainId/address", () => {
    // DOMAIN_SEPARATOR() read from tUSD8 on Aevum testnet (evidence/g1-fork.json, step 0)
    expect(domainSeparator(domain)).toBe("0x7838e6c46f8f9874236c9747d9896552a03d22c7c3e701b198879de2cb658022");
  });

  it("signs a payment and its cancel over the same nonce, both recoverable to the payer", async () => {
    const p = await signPair(account, domain, { to: payee, value: 1000n, validAfter: 100n, validBefore: 200n });
    const fromPay = await recoverTypedDataAddress({
      domain: toTypedDataDomain(domain),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: p.authorization,
      signature: p.payment.signature,
    });
    const fromCancel = await recoverTypedDataAddress({
      domain: toTypedDataDomain(domain),
      types: CANCEL_AUTHORIZATION_TYPES,
      primaryType: "CancelAuthorization",
      message: { authorizer: account.address, nonce: p.authorization.nonce },
      signature: p.cancel.signature,
    });
    expect(fromPay).toBe(account.address);
    expect(fromCancel).toBe(account.address);
    expect([27, 28]).toContain(p.payment.v);
    expect(p.paymentDigest).not.toBe(p.cancelDigest);
  });

  it("gives every line of a run its own nonce", async () => {
    const run = await signRun(account, domain, {
      validAfter: 100n,
      validBefore: 200n,
      lines: Array.from({ length: 6 }, (_, i) => ({ to: payee, value: BigInt(i + 1) })),
    });
    expect(new Set(run.map((l) => l.authorization.nonce)).size).toBe(6);
  });

  it("refuses an inverted window or a foreign `from`", async () => {
    const nonce: Hex = randomNonce();
    await expect(
      signTransferAuthorization(account, domain, { from: account.address, to: payee, value: 1n, validAfter: 5n, validBefore: 5n, nonce }),
    ).rejects.toThrow(/validBefore/);
    await expect(
      signTransferAuthorization(account, domain, { from: payee, to: payee, value: 1n, validAfter: 1n, validBefore: 5n, nonce }),
    ).rejects.toThrow(/signer/);
  });

  it("produces 32-byte random nonces", () => {
    expect(randomNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
