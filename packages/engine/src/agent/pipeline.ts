/**
 * The agent pipeline (architecture.md "Agent pipeline"): the model chooses where to look; deterministic code decides
 * what is true. retrieve → model findings → verify quotes → rules → policy → evidence.
 */
import type { Address, Hex } from "viem";
import { evidenceHash } from "brake-signer";
import { domainOf, isLookalike, isNearDomain } from "./domain.js";
import type { Decision, Finding, LineCtx, Message, RuleHit, Verdict } from "./types.js";

export const POLICY_VERSION = "brake-policy-1";

// ------------------------------------------------------------------------------------------------- retrieve

/**
 * Link window messages to lines. A message belongs to a line when it was received inside the line's review window and
 * its sender domain is the vendor's (or a lookalike), or it names the vendor, the invoice ref or the payee address.
 * Composer messages arrive pre-linked to the vendor the judge picked (`forcedVendor`).
 */
export function linkMessages(
  lines: LineCtx[],
  messages: (Message & { vendorId?: string | null })[],
): Map<number, Message[]> {
  const out = new Map<number, Message[]>();
  for (const l of lines) {
    const linked = messages.filter((m) => {
      if (m.receivedAt.getTime() < l.windowStart.getTime()) return false;
      if (m.vendorId) return m.vendorId === l.vendor.id;
      const text = `${m.subject}\n${m.body}`.toLowerCase();
      return (
        isNearDomain(m.fromDomain, l.vendor.domain) ||
        text.includes(l.vendor.name.toLowerCase()) ||
        text.includes(l.invoiceId.toLowerCase()) ||
        text.includes(l.payee.toLowerCase())
      );
    });
    out.set(l.idx, linked);
  }
  return out;
}

// --------------------------------------------------------------------------------------------------- verify

export interface Verified {
  verified: Finding[];
  unsupported: { finding: Finding; why: string }[];
}

/** Keep a finding only if it targets a real line and every quote is a verbatim substring of a message linked to it. */
export function verifyFindings(findings: Finding[], linked: Map<number, Message[]>): Verified {
  const verified: Finding[] = [];
  const unsupported: Verified["unsupported"] = [];
  for (const f of findings) {
    const msgs = linked.get(f.line);
    if (!msgs) {
      unsupported.push({ finding: f, why: "unknown line" });
      continue;
    }
    if (f.intent !== "BENIGN" && f.quotes.length === 0) {
      unsupported.push({ finding: f, why: "no quote" });
      continue;
    }
    const bad = f.quotes.find((q) => {
      const m = msgs.find((x) => x.id === q.messageId);
      return !m || q.text.trim().length === 0 || !`${m.subject}\n${m.body}`.includes(q.text);
    });
    if (bad) unsupported.push({ finding: f, why: `quote not verbatim in a linked message: ${bad.messageId}` });
    else verified.push(f);
  }
  return { verified, unsupported };
}

// ---------------------------------------------------------------------------------------------------- rules

export interface RuleEnv {
  isBlacklisted(payee: Address): Promise<boolean> | boolean;
  /** invoice refs held by other open (not STOPPED/REISSUED) lines of the same payer / demo scenario */
  otherOpenInvoices: Set<string>;
}

const RULE_ORDER = ["R-BL", "R-SRC", "R-DOM", "R-CHG", "R-DUP", "R-DSP", "R-AMT"] as const;

/** Rules can only STOP. Evaluated on the line's window messages plus the vendor snapshot. */
export async function evaluateRules(line: LineCtx, windowMsgs: Message[], env: RuleEnv): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  if (await env.isBlacklisted(line.payee)) {
    hits.push({ id: "R-BL", reason: "PAYEE_BLACKLISTED", detail: `tUSD8.isBlacklisted(${line.payee})` });
  }
  const look = windowMsgs.find((m) => isLookalike(m.fromDomain, line.vendor.domain));
  if (look) {
    hits.push({
      id: "R-DOM",
      reason: "SENDER_LOOKALIKE",
      detail: `${look.id} from ${look.fromDomain} imitates ${line.vendor.domain}`,
    });
  }
  const v = line.vendor;
  if (v.payeeChangedAt) {
    const src = v.payeeChangeSource;
    if (src && src !== "phone" && isLookalike(domainOf(src), v.domain)) {
      hits.push({ id: "R-SRC", reason: "BANK_CHANGE_UNVERIFIED", detail: `payee set from ${src}, a lookalike of ${v.domain}` });
    }
    if (v.payeeChangeVerified !== "phone") {
      hits.push({ id: "R-CHG", reason: "BANK_CHANGE_UNVERIFIED", detail: "payee changed without phone verification" });
    }
  }
  if (line.amountUnits !== line.invoiceAmountUnits) {
    hits.push({
      id: "R-AMT",
      reason: "AMOUNT_MISMATCH",
      detail: `line ${line.amountUnits} ≠ invoice ${line.invoiceAmountUnits}`,
    });
  }
  if (line.invoiceStatus === "disputed" || line.invoiceStatus === "goods_not_received") {
    hits.push({
      id: "R-DSP",
      reason: line.invoiceStatus === "disputed" ? "INVOICE_DISPUTED" : "GOODS_NOT_RECEIVED",
      detail: `ledger: ${line.invoiceId} ${line.invoiceStatus}`,
    });
  }
  if (env.otherOpenInvoices.has(line.invoiceId)) {
    hits.push({ id: "R-DUP", reason: "DUPLICATE_INVOICE", detail: `${line.invoiceId} already in another open line` });
  }
  return hits.sort((a, b) => RULE_ORDER.indexOf(a.id) - RULE_ORDER.indexOf(b.id));
}

// --------------------------------------------------------------------------------------------------- policy

const INTENT_REASON: Partial<Record<Finding["intent"], string>> = {
  PAYMENT_DETAIL_CHANGE: "PAYMENT_DETAIL_CHANGE",
  DISPUTE: "INVOICE_DISPUTED",
  GOODS_NOT_RECEIVED: "GOODS_NOT_RECEIVED",
  DUPLICATE: "DUPLICATE_INVOICE",
};

/**
 * STOP if any rule fires or a verified finding carries a stop intent. A verified INJECTION_ATTEMPT on a line whose payee
 * was ever changed → STOP (BANK_CHANGE_UNVERIFIED); otherwise → HOLD (INJECTION_FLAGGED). Else ALLOW.
 * Invariant I4: findings are consulted only after rules, so no model output can turn a rule STOP into anything else.
 */
export function decide(line: LineCtx, rules: RuleHit[], verified: Finding[]): Decision {
  const findings = verified.filter((f) => f.line === line.idx);
  const base = { idx: line.idx, rules, findings };
  if (rules.length > 0) return { ...base, verdict: "STOP", reason: rules[0]!.reason };
  const stopF = findings.find((f) => INTENT_REASON[f.intent]);
  if (stopF) return { ...base, verdict: "STOP", reason: INTENT_REASON[stopF.intent]! };
  if (findings.some((f) => f.intent === "INJECTION_ATTEMPT")) {
    if (line.vendor.payeeChangedAt) return { ...base, verdict: "STOP", reason: "BANK_CHANGE_UNVERIFIED" };
    return { ...base, verdict: "HOLD", reason: "INJECTION_FLAGGED" };
  }
  return { ...base, verdict: "ALLOW" as Verdict, reason: null };
}

// ------------------------------------------------------------------------------------------------- evidence

export interface EvidenceInput {
  chainId: number;
  brake: Address;
  runId: Hex;
  line: LineCtx;
  decision: Decision;
  messages: Message[];
  model: string;
}

/** Canonical evidence bundle: line params, rules fired, verified quotes + message ids, model id, policy version. */
export function buildEvidence(e: EvidenceInput) {
  const usedIds = new Set(e.decision.findings.flatMap((f) => f.quotes.map((q) => q.messageId)));
  const bundle = {
    v: 1,
    chainId: e.chainId,
    brake: e.brake.toLowerCase(),
    runId: e.runId,
    line: {
      idx: e.line.idx,
      payee: e.line.payee.toLowerCase(),
      amount: e.line.amountUnits.toString(),
      nonce: e.line.nonce,
      invoice: e.line.invoiceId,
      rev: e.line.evidenceRev,
    },
    verdict: e.decision.verdict,
    reason: e.decision.reason,
    rulesFired: e.decision.rules.map((r) => ({ id: r.id, reason: r.reason, detail: r.detail })),
    findings: e.decision.findings.map((f) => ({ intent: f.intent, quotes: f.quotes, note: f.note })),
    messages: e.messages
      .filter((m) => usedIds.has(m.id))
      .map((m) => ({ id: m.id, from: m.fromAddr, receivedAt: m.receivedAt.toISOString() })),
    model: e.model,
    policy: POLICY_VERSION,
  };
  return { bundle, hash: evidenceHash(bundle) };
}
