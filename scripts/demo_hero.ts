// pnpm demo:hero — the hero run end to end on Aevum testnet 44005 (DEPLOYMENT=live) or a local fork (DEPLOYMENT=fork):
// Monday review ALLOW ×4 → Tuesday's email (E4) → STOP line 3 → payday: 3 paid in one Multicall3 batch + the stopped
// line's proof-of-stop revert → finance re-issues line 3 to the phone-verified wallet + payer allow → paid → sweep-back.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv } from "./env.js";
import { loadConfig, REPO_ROOT } from "@brake/engine/config";
import { connect } from "@brake/engine/db";
import { seed } from "@brake/engine/seed";
import { makeChain } from "@brake/engine/chain";
import { modelFromEnv } from "@brake/engine/agent/model";
import { createRun, deliver, getLines, openRunOnChain, reissueLine } from "@brake/engine/runs";
import { runReviewJobs } from "@brake/engine/jobs";
import { payday, sweep } from "@brake/engine/keeper";
import { reconcile } from "@brake/engine/reconciler";
import { fromUnits } from "@brake/engine/fixtures";

loadLocalEnv();
const scenario = process.env.SCENARIO ?? "hero";
const cfg = loadConfig();
const ctx = makeChain(cfg);
const db = connect(cfg.databaseUrl);
const model = modelFromEnv();
const label = cfg.deployment === "live" ? "LIVE" : "FORK";
const t0 = Date.now();
const steps: Record<string, unknown>[] = [];
const log = (step: string, data: Record<string, unknown> = {}) => {
  const row = { step, at: new Date().toISOString(), sinceStartMs: Date.now() - t0, ...data };
  steps.push(row);
  console.log(`[${label} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const link = (h?: string | null) => (h ? (label === "LIVE" ? ctx.explorerTx(h as `0x${string}`) : `fork:${h}`) : null);

async function paydayWhenDue(tag: string) {
  for (;;) {
    const r = await payday(db, ctx, run.id);
    if (r.notYet.length && !r.batchTx && !r.proofs.length) {
      const wait = Math.max(...r.notYet.map((n) => n.secondsLeft));
      log(`${tag}: waiting for validAfter`, { secondsLeft: wait });
      await sleep(Math.min(wait, 30) * 1000 + 1500);
      continue;
    }
    return r;
  }
}

await seed(db, { mnemonic: cfg.payeesMnemonic!, scale: cfg.seedScale });
const run = await createRun(db, ctx, { scenario });
log("run created + signed (payment + paired cancel per line, sealed at rest)", { run: run.id, runId: run.runId, model: model.id });
const opened = await openRunOnChain(db, ctx, run.id);
log("openRun (payer)", { tx: opened.tx, link: link(opened.tx) });

const monday = await runReviewJobs(db, ctx, model, { runId: run.id });
for (const j of monday) log(`review (${j.trigger})`, { model: j.model, ms: j.ms, error: j.error, executed: j.executed });

const e4 = await deliver(db, ctx, run.id, { seed: "E4" });
log("deliver E4 (Tuesday's email)", { linkedLines: e4.linkedLines.map((i) => i + 1) });
const tuesday = await runReviewJobs(db, ctx, model, { runId: run.id });
for (const j of tuesday) log(`review (${j.trigger})`, { model: j.model, ms: j.ms, error: j.error, executed: j.executed, unsupported: j.unsupported });

const p1 = await paydayWhenDue("payday 1");
log("payday 1", {
  batchTx: p1.batchTx, link: link(p1.batchTx), simulation: p1.simulation, paid: p1.paid.map((p) => p.idx + 1),
  proofs: p1.proofs.map((p) => ({ line: p.idx + 1, tx: p.tx, link: link(p.tx), replayed: p.replayed })), held: p1.held,
});

const stopped = (await getLines(db, run.id)).filter((l) => l.status === "STOPPED");
let p2 = null;
for (const s of stopped) {
  const re = await reissueLine(db, ctx, run.id, s.idx);
  log(`re-issue line ${s.idx + 1} → genuine wallet (phone-verified) + payer allow (FINANCE_ALLOW)`, {
    newLine: re.newIdx + 1, reissueTx: re.reissueTx, allowTx: re.allowTx, link: link(re.reissueTx),
  });
}
if (stopped.length) {
  p2 = await paydayWhenDue("payday 2");
  log("payday 2 (re-issued line)", { batchTx: p2.batchTx, link: link(p2.batchTx), paid: p2.paid.map((p) => p.idx + 1), held: p2.held });
}

const rec = await reconcile(db, ctx);
log("reconcile", { from: rec.from, to: rec.to, events: rec.events, updates: rec.updates.length, retried: rec.retried.length });
const sw = await sweep(db, ctx, run.id);
log("sweep-back to payer", { tx: sw.tx, swept: sw.swept });

const lines = await getLines(db, run.id);
const decisions = (await db.query(`select idx, verdict, rev, reason_code, rules_fired, model, evidence_hash, tx, chain_status from decisions where run_id = $1 order by created_at`, [run.id])).rows;
const summary = {
  deployment: cfg.deployment,
  note: label === "FORK" ? "Anvil fork of Aevum 44005 — these hashes exist only on the local fork, never on the explorer." : undefined,
  scenario,
  run: run.id,
  runId: run.runId,
  brake: cfg.brake,
  seedScale: cfg.seedScale,
  model: model.id,
  lines: lines.map((l) => ({
    line: l.idx + 1, invoice: l.invoice_id, payee: l.payee, amount: fromUnits(BigInt(l.amount_units)), status: l.status,
    paidTx: l.paid_tx, stopTx: l.stop_tx, proofTx: l.proof_tx, proofReason: l.proof_reason, reissuedFrom: l.reissued_from === null ? null : l.reissued_from + 1,
  })),
  decisions,
  steps,
  totalMs: Date.now() - t0,
};
const out = join(REPO_ROOT, "evidence", `${scenario}-${cfg.deployment}.json`);
writeFileSync(out, JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(`\nwrote ${out}`);
console.table(summary.lines.map((l) => ({ line: l.line, invoice: l.invoice, amount: l.amount, status: l.status })));
await db.end();
