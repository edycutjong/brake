import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Hex } from "viem";
import { brakeAbi, lineStatus, reasonToBytes32, type LineStatus } from "brake-signer";
import { sendQueued, wallet, type ChainCtx } from "./chain.js";
import { lock, newId, withTx, type Db } from "./db.js";
import type { ReviewedLine } from "./agent/review.js";
import { enqueueReview, evidenceUri, getRun, loadSig } from "./runs.js";

export type Action = "allow" | "hold" | "stop" | "noop";

/**
 * Executor table (architecture "Chain plumbing"): verdict × current on-chain Brake status → action.
 * ALLOW on OPEN → allow; ALLOW on ALLOWED → allow again only if the evidence revision changed; HOLD on OPEN/ALLOWED → hold;
 * HOLD on HELD → no-op; STOP on OPEN/ALLOWED/HELD → stop; anything on STOPPED/REISSUED/CONSUMED → no-op (terminal).
 */
export function planAction(verdict: "ALLOW" | "HOLD" | "STOP", chain: LineStatus, revChanged: boolean): Action {
  if (chain === "STOPPED" || chain === "REISSUED" || chain === "CONSUMED" || chain === "NONE") return "noop";
  if (verdict === "ALLOW") return chain === "OPEN" || (chain === "ALLOWED" && revChanged) ? "allow" : "noop";
  if (verdict === "HOLD") return chain === "OPEN" || chain === "ALLOWED" ? "hold" : "noop";
  return "stop";
}

export interface Executed {
  idx: number;
  verdict: string;
  action: Action | "stale" | "budget-hold";
  tx?: Hex;
  chainStatus?: string;
  note?: string;
}

const decisionKey = (id: string, idx: number, rev: number, verdict: string) => `${id}:${idx}:r${rev}:${verdict}`;

/**
 * Apply one review's decisions. Each line's evidence revision is re-read under the per-run advisory lock (the same lock
 * inbox linking and finance decisions take) right before broadcast; a decision made on an older revision is dropped and
 * the run re-reviewed. Every action carries an idempotency key, so a retried job never double-sends.
 */
export async function applyDecisions(db: Db, ctx: ChainCtx, id: string, reviewed: ReviewedLine[], model: string): Promise<Executed[]> {
  const run = await getRun(db, id);
  const out: Executed[] = [];
  await withTx(db, async (c) => {
    await lock(c, `run:${id}`);
    const cur = await c.query<{ idx: number; evidence_rev: number; status: string }>(
      `select idx, evidence_rev, status from lines where run_id = $1`,
      [id],
    );
    const revOf = new Map(cur.rows.map((r) => [r.idx, r.evidence_rev]));
    const allowBatch: { r: ReviewedLine; key: string }[] = [];
    let stale = false;

    for (const r of reviewed) {
      const { idx, verdict } = r.decision;
      const rev = r.evidence.line.rev;
      if (revOf.get(idx) !== rev) {
        out.push({ idx, verdict, action: "stale", note: `decided on rev ${rev}, line is at rev ${revOf.get(idx)}` });
        stale = true;
        continue;
      }
      const key = decisionKey(id, idx, rev, verdict);
      // autocommit (not `c`): the tx helpers update this row from other connections; the run lock still serializes
      await db.query(
        `insert into decisions (id, run_id, idx, verdict, rev, reason_code, rules_fired, quotes, model, evidence, evidence_hash, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (idempotency_key) do nothing`,
        [
          newId("dec"), id, idx, verdict, rev, r.decision.reason, JSON.stringify(r.decision.rules),
          JSON.stringify(r.decision.findings.flatMap((f) => f.quotes)), model, JSON.stringify(r.evidence), r.evidenceHash, key,
        ],
      );
      const on = (await lineStatus(ctx.pub, ctx.cfg.brake, run.run_id, idx)).status;
      const lastAllow = await c.query<{ rev: number }>(
        `select rev from decisions where run_id = $1 and idx = $2 and verdict in ('ALLOW','FINANCE_ALLOW') and tx is not null
          order by created_at desc limit 1`,
        [id, idx],
      );
      const revChanged = lastAllow.rows[0] ? lastAllow.rows[0].rev !== rev : true;
      const action = planAction(verdict, on, revChanged);
      if (action === "allow") allowBatch.push({ r, key });
      else if (action === "noop") out.push({ idx, verdict, action, chainStatus: on });
      else if (action === "hold") out.push(await sendHold(db, ctx, id, run.run_id, idx, r.decision.reason ?? "INJECTION_FLAGGED", r.evidenceHash, key, verdict));
      else out.push(await sendStop(db, ctx, id, run.run_id, idx, r, key));
    }

    if (allowBatch.length) {
      const data = encodeFunctionData({
        abi: brakeAbi,
        functionName: "allow",
        args: [
          run.run_id,
          allowBatch.map((a) => BigInt(a.r.decision.idx)),
          allowBatch.map((a) => a.r.evidenceHash),
          allowBatch.map((a) => evidenceUri(ctx, a.r.evidenceHash)),
        ],
      });
      const tx = await sendQueued(db, ctx, {
        role: "agent",
        runId: id,
        action: "allow",
        idempotencyKey: `tx:allow:${allowBatch.map((a) => a.key).join(",")}`,
        to: ctx.cfg.brake,
        data,
      });
      for (const a of allowBatch) {
        const ok = tx.status === "mined";
        if (ok) await db.query(`update lines set status = 'ALLOWED' where run_id = $1 and idx = $2 and status in ('OPEN','ALLOWED')`, [id, a.r.decision.idx]);
        await db.query(`update decisions set tx = $2, chain_status = $3 where idempotency_key = $1`, [a.key, tx.hash, ok ? "ALLOWED" : "reverted"]);
        out.push({ idx: a.r.decision.idx, verdict: "ALLOW", action: "allow", tx: tx.hash, chainStatus: ok ? "ALLOWED" : "reverted" });
      }
    }
    if (stale) await enqueueReview(c, id, "stale");
  });
  return out.sort((a, b) => a.idx - b.idx);
}

export async function sendHold(db: Db, ctx: ChainCtx, id: string, runId: Hex, idx: number, reason: string, evidenceHash: Hex, key: string, verdict = "HOLD"): Promise<Executed> {
  const data = encodeFunctionData({ abi: brakeAbi, functionName: "hold", args: [runId, BigInt(idx), reasonToBytes32(reason), evidenceHash] });
  const tx = await sendQueued(db, ctx, { role: "agent", runId: id, idx, action: "hold", idempotencyKey: `tx:${key}:hold`, to: ctx.cfg.brake, data });
  const ok = tx.status === "mined";
  if (ok) await db.query(`update lines set status = 'HELD' where run_id = $1 and idx = $2`, [id, idx]);
  await db.query(`update decisions set tx = $2, chain_status = $3 where idempotency_key = $1`, [key, tx.hash, ok ? "HELD" : "reverted"]);
  await db.query(
    `insert into tickets (id, kind, run_id, idx, body) select $1,'held',$2,$3,$4
      where not exists (select 1 from tickets where kind = 'held' and run_id = $2 and idx = $3 and status = 'open')`,
    [newId("tkt"), id, idx, `line ${idx} held (${reason}) — finance decides: allow or stop`],
  );
  return { idx, verdict, action: "hold", tx: tx.hash, chainStatus: ok ? "HELD" : "reverted", note: reason };
}

function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason;
  }
  return undefined;
}

/**
 * Stop: simulate first. StopBudgetExhausted → hold (BUDGET_EXHAUSTED) + escalation ticket instead of a failing tx.
 * Otherwise send `Brake.stop` with the payer's pre-signed cancel; the result is STOPPED, or CONSUMED when the payment
 * landed first (the reconciler turns that into TOO_LATE / EXTERNALLY_CANCELLED from tUSD8 logs).
 */
export async function sendStop(db: Db, ctx: ChainCtx, id: string, runId: Hex, idx: number, r: ReviewedLine, key: string): Promise<Executed> {
  const reason = r.decision.reason ?? "PAYMENT_DETAIL_CHANGE";
  const c = await loadSig(db, ctx.cfg.sigEncKey!, id, idx, "cancel");
  const args = [runId, BigInt(idx), reasonToBytes32(reason), r.evidenceHash, evidenceUri(ctx, r.evidenceHash), c.sig.v, c.sig.r, c.sig.s] as const;
  try {
    await ctx.pub.simulateContract({ address: ctx.cfg.brake, abi: brakeAbi, functionName: "stop", args, account: wallet(ctx, "agent").account });
  } catch (e) {
    const name = revertName(e);
    if (name === "StopBudgetExhausted") {
      const held = await sendHold(db, ctx, id, runId, idx, "BUDGET_EXHAUSTED", r.evidenceHash, key, "STOP");
      await db.query(`insert into tickets (id, kind, run_id, idx, body) values ($1,'escalation',$2,$3,$4)`, [
        newId("tkt"), id, idx, `stop budget exhausted: line ${idx} wanted STOP (${reason}); held for finance`,
      ]);
      return { ...held, action: "budget-hold", note: `StopBudgetExhausted → held (${reason})` };
    }
    throw e;
  }
  const data = encodeFunctionData({ abi: brakeAbi, functionName: "stop", args });
  const tx = await sendQueued(db, ctx, { role: "agent", runId: id, idx, action: "stop", idempotencyKey: `tx:${key}:stop`, to: ctx.cfg.brake, data, gas: 600_000n });
  const after = (await lineStatus(ctx.pub, ctx.cfg.brake, runId, idx)).status;
  const dbStatus = after === "STOPPED" ? "STOPPED" : after === "CONSUMED" ? "CONSUMED" : undefined;
  if (dbStatus) await db.query(`update lines set status = $3, stop_tx = $4 where run_id = $1 and idx = $2`, [id, idx, dbStatus, tx.hash]);
  await db.query(`update decisions set tx = $2, chain_status = $3 where idempotency_key = $1`, [key, tx.hash, tx.status === "mined" ? after : "reverted"]);
  return { idx, verdict: "STOP", action: "stop", tx: tx.hash, chainStatus: after, note: reason };
}
