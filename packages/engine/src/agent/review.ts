import type { Address, Hex } from "viem";
import type { ModelClient } from "./model.js";
import { buildEvidence, decide, evaluateRules, linkMessages, verifyFindings, type RuleEnv } from "./pipeline.js";
import type { Decision, LineCtx, Message } from "./types.js";

export interface ReviewedLine {
  decision: Decision;
  evidence: ReturnType<typeof buildEvidence>["bundle"];
  evidenceHash: Hex;
  linkedIds: string[];
}

export interface ReviewOutput {
  model: string;
  lines: ReviewedLine[];
  unsupported: { line: number; intent: string; why: string }[];
}

/**
 * One review pass over a run's reviewable lines. Agent module boundary (invariant I1): this code receives line params
 * and messages only — never a signature, key or DB handle.
 */
export async function reviewRun(args: {
  chainId: number;
  brake: Address;
  runId: Hex;
  lines: LineCtx[];
  messages: (Message & { vendorId?: string | null })[];
  model: ModelClient;
  rules: RuleEnv;
}): Promise<ReviewOutput> {
  const linked = linkMessages(args.lines, args.messages);
  const res = await args.model.findings({ lines: args.lines, linked });
  const { verified, unsupported } = verifyFindings(res.findings, linked);
  const out: ReviewedLine[] = [];
  for (const line of args.lines) {
    const msgs = linked.get(line.idx) ?? [];
    const rules = await evaluateRules(line, msgs, args.rules);
    const decision = decide(line, rules, verified, unsupported.map((u) => u.finding));
    const ev = buildEvidence({
      chainId: args.chainId,
      brake: args.brake,
      runId: args.runId,
      line,
      decision,
      messages: msgs,
      model: res.model,
    });
    out.push({ decision, evidence: ev.bundle, evidenceHash: ev.hash, linkedIds: msgs.map((m) => m.id) });
  }
  return {
    model: res.model,
    lines: out,
    unsupported: unsupported.map((u) => ({ line: u.finding.line, intent: u.finding.intent, why: u.why })),
  };
}
