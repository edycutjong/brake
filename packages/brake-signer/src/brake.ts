/**
 * Brake contract helpers: open a signed run, stop a line with its pre-signed cancel, read a line's status,
 * and hash / verify the evidence bundle a decision commits on-chain.
 */
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  keccak256,
  stringToBytes,
  stringToHex,
} from "viem";
import { brakeAbi } from "./brakeAbi.js";
import type { SignedPair } from "./index.js";

export { brakeAbi };

export const LINE_STATUS = ["NONE", "OPEN", "ALLOWED", "HELD", "STOPPED", "CONSUMED", "REISSUED"] as const;
export type LineStatus = (typeof LINE_STATUS)[number];

/** Reasons Brake.stop accepts (Brake.isStopReason). */
export const STOP_REASONS = [
  "BANK_CHANGE_UNVERIFIED",
  "INVOICE_DISPUTED",
  "GOODS_NOT_RECEIVED",
  "PAYEE_BLACKLISTED",
  "DUPLICATE_INVOICE",
  "AMOUNT_MISMATCH",
  "SENDER_LOOKALIKE",
  "PAYMENT_DETAIL_CHANGE",
] as const;
/** Extra reasons Brake.hold accepts (Brake.isHoldReason). */
export const HOLD_ONLY_REASONS = ["INJECTION_FLAGGED", "BUDGET_EXHAUSTED", "REVIEW_STALE"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export type HoldReason = StopReason | (typeof HOLD_ONLY_REASONS)[number];

export const reasonToBytes32 = (r: string): Hex => stringToHex(r, { size: 32 });

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

export interface OpenRunParams {
  runId: Hex;
  agentId: bigint;
  agent: Address;
  agentExpiry: bigint;
  maxStops: number;
  alarmAt: number;
  pairs: SignedPair[];
}

/** Payer registers the run in Brake; every pair must share one validAfter/validBefore. */
export async function openRun(wallet: Wallet, brake: Address, p: OpenRunParams): Promise<Hex> {
  if (p.pairs.length === 0) throw new Error("empty run");
  const { validAfter, validBefore } = p.pairs[0]!.authorization;
  for (const s of p.pairs) {
    if (s.authorization.validAfter !== validAfter || s.authorization.validBefore !== validBefore) {
      throw new Error("all lines of a run share one payment window");
    }
    if (s.authorization.from.toLowerCase() !== wallet.account.address.toLowerCase()) {
      throw new Error("the payer must sign every line");
    }
  }
  return wallet.writeContract({
    address: brake,
    abi: brakeAbi,
    functionName: "openRun",
    args: [
      p.runId,
      p.agentId,
      p.agent,
      p.agentExpiry,
      p.maxStops,
      p.alarmAt,
      validAfter,
      validBefore,
      p.pairs.map((s) => ({ payee: s.authorization.to, amount: s.authorization.value, nonce: s.authorization.nonce })),
    ],
    chain: wallet.chain,
  });
}

export interface StopParams {
  runId: Hex;
  idx: number;
  reason: StopReason;
  evidenceHash: Hex;
  uri: string;
  cancel: { v: number; r: Hex; s: Hex };
}

/** Agent stops a line: Brake submits the payer's pre-signed cancelAuthorization to the token. */
export async function stopLine(wallet: Wallet, brake: Address, p: StopParams, opts: { gas?: bigint; nonce?: number } = {}) {
  return wallet.writeContract({
    address: brake,
    abi: brakeAbi,
    functionName: "stop",
    args: [p.runId, BigInt(p.idx), reasonToBytes32(p.reason), p.evidenceHash, p.uri, p.cancel.v, p.cancel.r, p.cancel.s],
    chain: wallet.chain,
    ...opts,
  });
}

export async function lineStatus(client: PublicClient, brake: Address, runId: Hex, idx: number) {
  const [line, status] = (await client.readContract({
    address: brake,
    abi: brakeAbi,
    functionName: "lineOf",
    args: [runId, BigInt(idx)],
  })) as readonly [{ payee: Address; amount: bigint; nonce: Hex }, number];
  return { ...line, status: LINE_STATUS[status] ?? "NONE" };
}

// ------------------------------------------------------------------------------------------------- evidence

/** Deterministic JSON: object keys sorted, bigint as decimal string, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const evidenceHash = (bundle: unknown): Hex => keccak256(stringToBytes(canonicalJson(bundle)));

const validationStatusAbi = [
  {
    type: "function",
    name: "getValidationStatus",
    stateMutability: "view",
    inputs: [{ name: "requestHash", type: "bytes32" }],
    outputs: [
      { name: "validatorAddress", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "response", type: "uint8" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
      { name: "lastUpdate", type: "uint256" },
    ],
  },
] as const;

export interface VerifyResult {
  ok: boolean;
  recomputed: Hex;
  onChain?: Hex;
  tag?: string;
  response?: number;
  reason?: string;
}

/**
 * Recompute a bundle's hash and compare it with what the chain holds: either a given hash (e.g. from a LineStopped
 * log) or the ERC-8004 Validation Registry's latest response for the line's request hash.
 */
export async function verifyEvidence(
  bundle: unknown,
  against: { hash: Hex } | { client: PublicClient; brake: Address; validation: Address; runId: Hex; idx: number },
): Promise<VerifyResult> {
  const recomputed = evidenceHash(bundle);
  if ("hash" in against) {
    const ok = recomputed.toLowerCase() === against.hash.toLowerCase();
    return { ok, recomputed, onChain: against.hash, reason: ok ? undefined : "hash mismatch" };
  }
  const rh = (await against.client.readContract({
    address: against.brake,
    abi: brakeAbi,
    functionName: "requestHashOf",
    args: [against.runId, BigInt(against.idx)],
  })) as Hex;
  const [, , response, responseHash, tag] = await against.client.readContract({
    address: against.validation,
    abi: validationStatusAbi,
    functionName: "getValidationStatus",
    args: [rh],
  });
  const ok = recomputed.toLowerCase() === responseHash.toLowerCase();
  return { ok, recomputed, onChain: responseHash, tag, response, reason: ok ? undefined : "hash mismatch" };
}
