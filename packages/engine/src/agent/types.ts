import type { Address, Hex } from "viem";

export const INTENTS = [
  "PAYMENT_DETAIL_CHANGE",
  "DISPUTE",
  "GOODS_NOT_RECEIVED",
  "DUPLICATE",
  "INJECTION_ATTEMPT",
  "BENIGN",
] as const;
export type Intent = (typeof INTENTS)[number];

/** An email in a run's inbox. Body and sender are untrusted text. */
export interface Message {
  id: string;
  fromAddr: string;
  fromDomain: string;
  subject: string;
  body: string;
  receivedAt: Date;
}

export interface VendorSnapshot {
  id: string;
  name: string;
  domain: string;
  payee: Address;
  genuinePayee: Address;
  payeeChangedAt: Date | null;
  /** 'phone' or the sender address the change came from, e.g. 'billing@acme-logistics.example' */
  payeeChangeSource: string | null;
  /** 'phone' | 'email-reply' | null */
  payeeChangeVerified: string | null;
}

export interface LineCtx {
  idx: number;
  vendor: VendorSnapshot;
  invoiceId: string;
  invoiceAmountUnits: bigint;
  /** ledger status: open | disputed | goods_not_received | paid */
  invoiceStatus: string;
  payee: Address;
  amountUnits: bigint;
  nonce: Hex;
  /** DB status of the line (OPEN, ALLOWED, STOPPED, …) */
  status: string;
  evidenceRev: number;
  /** messages received at or after this instant are in this line's review window (run open, or re-issue time) */
  windowStart: Date;
}

export interface Quote {
  messageId: string;
  text: string;
}

export interface Finding {
  line: number;
  intent: Intent;
  quotes: Quote[];
  note: string;
}

export type RuleId = "R-BL" | "R-DOM" | "R-SRC" | "R-CHG" | "R-AMT" | "R-DSP" | "R-DUP";

export interface RuleHit {
  id: RuleId;
  reason: string;
  detail: string;
}

export type Verdict = "ALLOW" | "STOP" | "HOLD";

export interface Decision {
  idx: number;
  verdict: Verdict;
  reason: string | null;
  rules: RuleHit[];
  findings: Finding[];
  /** non-BENIGN findings for this line whose quotes did not verify — recorded in the evidence, they can only HOLD */
  unverified?: Finding[];
}
