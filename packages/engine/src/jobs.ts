import { eip3009Abi } from "brake-signer";
import type { Address } from "viem";
import type { ChainCtx } from "./chain.js";
import type { Db } from "./db.js";
import { applyDecisions, type Executed } from "./executor.js";
import type { ModelClient } from "./agent/model.js";
import { reviewRun } from "./agent/review.js";
import { getRun, lineContexts, runMessages } from "./runs.js";

export interface JobResult {
  jobId: string;
  runId: string;
  trigger: string;
  model?: string;
  executed?: Executed[];
  unsupported?: { line: number; intent: string; why: string }[];
  error?: string;
  ms: number;
}

/**
 * Claim and run queued review jobs (optionally for one run): `for update skip locked` + a 300 s lease, so concurrent
 * workers (a request's after() and the cron tick) never run the same job. A failed job is retried up to 3 attempts.
 * Completion is fenced on the claimed attempt, so a worker that outlived its lease cannot overwrite the newer claim, and
 * a job whose final attempt died with its worker is marked failed instead of staying 'running' (a2a arch r01).
 */
export async function runReviewJobs(db: Db, ctx: ChainCtx, model: ModelClient, opts: { runId?: string; max?: number } = {}): Promise<JobResult[]> {
  const out: JobResult[] = [];
  await db.query(
    `update review_jobs set status = 'failed', error = coalesce(error, 'worker lost on the final attempt (lease expired)')
      where status = 'running' and lease_until < now() and attempts >= 3`,
  );
  for (let n = 0; n < (opts.max ?? 10); n++) {
    const claim = await db.query<{ id: string; run_id: string; trigger: string; attempts: number }>(
      `update review_jobs set status = 'running', attempts = attempts + 1, lease_until = now() + interval '300 seconds'
        where id = (select id from review_jobs
                     where (status = 'queued' or (status = 'running' and lease_until < now())) and attempts < 3
                       and ($1::text is null or run_id = $1)
                     order by created_at for update skip locked limit 1)
        returning id, run_id, trigger, attempts`,
      [opts.runId ?? null],
    );
    const job = claim.rows[0];
    if (!job) break;
    const t0 = Date.now();
    try {
      const r = await reviewOnce(db, ctx, model, job.run_id);
      await db.query(`update review_jobs set status = 'done', error = null where id = $1 and attempts = $2 and status = 'running'`, [job.id, job.attempts]);
      out.push({ jobId: job.id, runId: job.run_id, trigger: job.trigger, ...r, ms: Date.now() - t0 });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await db.query(
        `update review_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end, error = $2
          where id = $1 and attempts = $3 and status = 'running'`,
        [job.id, msg, job.attempts],
      );
      out.push({ jobId: job.id, runId: job.run_id, trigger: job.trigger, error: msg, ms: Date.now() - t0 });
    }
  }
  return out;
}

/** One review of a run's reviewable lines → decisions → executor. The agent sees line params + messages only (I1). */
export async function reviewOnce(db: Db, ctx: ChainCtx, model: ModelClient, id: string) {
  const run = await getRun(db, id);
  const lines = await lineContexts(db, id, { reviewableOnly: true });
  if (!lines.length) return { model: "n/a", executed: [], unsupported: [] };
  const messages = await runMessages(db, id);
  const invoices = lines.map((l) => l.invoiceId);
  const review = await reviewRun({
    chainId: ctx.cfg.chainId,
    brake: ctx.cfg.brake,
    runId: run.run_id,
    lines,
    messages,
    model,
    rules: {
      isBlacklisted: async (payee: Address) =>
        (await ctx.pub.readContract({ address: ctx.cfg.token, abi: eip3009Abi, functionName: "isBlacklisted", args: [payee] })) as boolean,
      // duplicates are judged within the run: concurrent visitors' demo runs share invoices by design
      otherOpenInvoices: new Set(invoices.filter((inv, i) => invoices.indexOf(inv) !== i)),
    },
  });
  const executed = await applyDecisions(db, ctx, id, review.lines, review.model);
  await db.query(`insert into cursors (name, last_block) values ('last_model_call', $1) on conflict (name) do update set last_block = excluded.last_block`, [
    Date.now(),
  ]);
  return { model: review.model, executed, unsupported: review.unsupported };
}
