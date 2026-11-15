import { describe, expect, it } from "vitest";
import { hexToString, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalJson,
  evidenceHash,
  lineStatus,
  openRun,
  reasonToBytes32,
  signRun,
  stopLine,
  verifyEvidence,
  type TokenDomain,
} from "../src/index.js";

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const domain: TokenDomain = {
  name: "tUSD8",
  version: "2",
  chainId: 44005,
  verifyingContract: "0x456569838f1d43009A91ebA4263147Afd7233483",
};
const BRAKE = "0x00000000000000000000000000000000000000b1" as const;

function fakeWallet(account = payer) {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  return {
    calls,
    wallet: {
      account,
      chain: undefined,
      writeContract: async (p: { functionName: string; args: readonly unknown[] }) => {
        calls.push(p);
        return `0x${"ee".repeat(32)}` as Hex;
      },
    } as never,
  };
}

describe("evidence hashing", () => {
  it("canonical JSON sorts keys recursively and renders bigint as a string", () => {
    expect(canonicalJson({ b: 1n, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":"1"}');
    expect(evidenceHash({ x: 1, y: 2 })).toBe(evidenceHash({ y: 2, x: 1 }));
  });

  it("verifyEvidence recomputes and reports a mismatch as such", async () => {
    const bundle = { verdict: "STOP", reason: "PAYMENT_DETAIL_CHANGE" };
    expect((await verifyEvidence(bundle, { hash: evidenceHash(bundle) })).ok).toBe(true);
    const bad = await verifyEvidence({ ...bundle, reason: "X" }, { hash: evidenceHash(bundle) });
    expect(bad).toMatchObject({ ok: false, reason: "hash mismatch" });
  });

  it("verifyEvidence reads the registry's latest response hash for the line", async () => {
    const bundle = { a: 1 };
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "requestHashOf"
          ? `0x${"aa".repeat(32)}`
          : [BRAKE, 0n, 0, evidenceHash(bundle), "PAYMENT_DETAIL_CHANGE", 1n],
    } as unknown as PublicClient;
    const r = await verifyEvidence(bundle, { client, brake: BRAKE, validation: BRAKE, runId: `0x${"01".repeat(32)}`, idx: 2 });
    expect(r).toMatchObject({ ok: true, tag: "PAYMENT_DETAIL_CHANGE", response: 0 });
  });
});

describe("contract helpers", () => {
  it("openRun sends the signed lines with the shared window", async () => {
    const pairs = await signRun(payer, domain, {
      validAfter: 100n,
      validBefore: 200n,
      lines: [
        { to: other.address, value: 5n },
        { to: payer.address, value: 7n },
      ],
    });
    const { wallet, calls } = fakeWallet();
    await openRun(wallet, BRAKE, { runId: `0x${"01".repeat(32)}`, agentId: 0n, agent: other.address, agentExpiry: 200n, maxStops: 2, alarmAt: 2, pairs });
    expect(calls[0]!.functionName).toBe("openRun");
    const args = calls[0]!.args;
    expect(args.slice(6, 8)).toEqual([100n, 200n]);
    expect((args[8] as { payee: string; amount: bigint; nonce: Hex }[]).map((l) => l.amount)).toEqual([5n, 7n]);
    expect((args[8] as { nonce: Hex }[])[0]!.nonce).toBe(pairs[0]!.authorization.nonce);
  });

  it("openRun refuses mixed windows and lines signed by someone else", async () => {
    const a = await signRun(payer, domain, { validAfter: 100n, validBefore: 200n, lines: [{ to: other.address, value: 1n }] });
    const b = await signRun(payer, domain, { validAfter: 101n, validBefore: 200n, lines: [{ to: other.address, value: 1n }] });
    const { wallet } = fakeWallet();
    const base = { runId: `0x${"01".repeat(32)}` as Hex, agentId: 0n, agent: other.address, agentExpiry: 200n, maxStops: 1, alarmAt: 1 };
    await expect(openRun(wallet, BRAKE, { ...base, pairs: [...a, ...b] })).rejects.toThrow(/one payment window/);
    await expect(openRun(fakeWallet(other).wallet, BRAKE, { ...base, pairs: a })).rejects.toThrow(/payer must sign/);
  });

  it("stopLine encodes the reason as bytes32 and passes the pre-signed cancel", async () => {
    const [pair] = await signRun(payer, domain, { validAfter: 1n, validBefore: 2n, lines: [{ to: other.address, value: 1n }] });
    const { wallet, calls } = fakeWallet(other);
    await stopLine(wallet, BRAKE, { runId: `0x${"01".repeat(32)}`, idx: 2, reason: "PAYMENT_DETAIL_CHANGE", evidenceHash: `0x${"cc".repeat(32)}`, uri: "u", cancel: pair!.cancel }, { gas: 400_000n });
    const args = calls[0]!.args;
    expect(hexToString(args[2] as Hex, { size: 32 })).toBe("PAYMENT_DETAIL_CHANGE");
    expect(args.slice(5)).toEqual([pair!.cancel.v, pair!.cancel.r, pair!.cancel.s]);
    expect(reasonToBytes32("ALLOW")).toHaveLength(66);
  });

  it("lineStatus maps the enum to a name", async () => {
    const client = { readContract: async () => [{ payee: other.address, amount: 3n, nonce: `0x${"01".repeat(32)}` }, 4] } as unknown as PublicClient;
    expect(await lineStatus(client, BRAKE, `0x${"01".repeat(32)}`, 0)).toMatchObject({ status: "STOPPED", amount: 3n });
  });
});
