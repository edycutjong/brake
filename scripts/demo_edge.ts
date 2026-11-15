// pnpm demo:late  — run B, TOO LATE: 1 line, payday = now. Review ALLOWs, the keeper pays, THEN the vendor's "double billed"
//                   email (E13) arrives → the agent stops → Brake records CONSUMED (nonce already used) → the reconciler reads
//                   AuthorizationUsed → TOO_LATE + recovery ticket. The agent never claims a stop it did not make.
// pnpm demo:flood — run C, stop budget: 3 lookalike "goods not received" emails (E14–E16) → stop #1, stop #2 (StopAlarm),
//                   attempt #3 → StopBudgetExhausted → on-chain hold + escalation ticket; payday proves both stops.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv } from "./env.js";
import { loadConfig, REPO_ROOT } from "@brake/engine/config";
import { connect } from "@brake/engine/db";
import { seed } from "@brake/engine/seed";
import { makeChain } from "@brake/engine/chain";
import { modelFromEnv } from "@brake/engine/agent/model";
import { createRun, deliver, getLines, openRunOnChain } from "@brake/engine/runs";
import { runReviewJobs } from "@brake/engine/jobs";
import { payday, sweep } from "@brake/engine/keeper";
import { reconcile } from "@brake/engine/reconciler";
import { fromUnits } from "@brake/engine/fixtures";

loadLocalEnv();
const scenario = process.argv[2] === "flood" ? "flood" : "late";
const cfg = loadConfig();
const ctx = makeChain(cfg);
const db = connect(cfg.databaseUrl);
const model = modelFromEnv();
const label = cfg.deployment === "live" ? "LIVE" : "FORK";
const t0 = Date.now();
const steps: Record<string, unknown>[] = [];
const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const log = (step: string, data: Record<string, unknown> = {}) => {
  steps.push({ step, at: new Date().toISOString(), sinceStartMs: Date.now() - t0, ...data });
  console.log(`[${label} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`, enc(data));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reviews = async (tag: string) => {
  for (const j of await runReviewJobs(db, ctx, model, { runId: run.id })) {
    log(`review (${tag}: ${j.trigger})`, { model: j.model, ms: j.ms, error: j.error, executed: j.executed });
  }
};
async function paydayWhenDue() {
  for (;;) {
    const r = await payday(db, ctx, run.id);
    if (r.notYet.length && !r.batchTx && !r.proofs.length) {
      await sleep(Math.min(Math.max(...r.notYet.map((n) => n.secondsLeft)), 30) * 1000 + 1500);
      continue;
    }
    return r;
  }
}

await seed(db, { mnemonic: cfg.payeesMnemonic!, scale: cfg.seedScale });
const run = await createRun(db, ctx, { scenario });
log("run created + signed", { run: run.id, runId: run.runId, model: model.id });
log("openRun (payer)", { tx: (await openRunOnChain(db, ctx, run.id)).tx });
await reviews("open");

if (scenario === "late") {
  const p = await paydayWhenDue();
  log("payday (keeper pays first)", { batchTx: p.batchTx, paid: p.paid.map((x) => x.idx + 1) });
  const e = await deliver(db, ctx, run.id, { seed: "E13" });
  log("deliver E13 (double billed) — after the payment", { linkedLines: e.linkedLines.map((i) => i + 1) });
  await reviews("E13");
} else {
  for (const id of ["E14", "E15", "E16"]) {
    const e = await deliver(db, ctx, run.id, { seed: id });
    log(`deliver ${id}`, { linkedLines: e.linkedLines.map((i) => i + 1) });
    await reviews(id);
  }
  const p = await paydayWhenDue();
  log("payday", {
    batchTx: p.batchTx, paid: p.paid.map((x) => x.idx + 1), held: p.held,
    proofs: p.proofs.map((x) => ({ line: x.idx + 1, tx: x.tx, replayed: x.replayed })),
  });
}

const rec = await reconcile(db, ctx);
log("reconcile", { events: rec.events, updates: rec.updates });
const alarms = (await db.query(`select name, tx_hash, args from chain_events where run_id = $1 and name in ('StopAlarm','StopConsumed','LineHeld') order by block_number`, [run.id])).rows;
const tickets = (await db.query(`select kind, idx, body from tickets where run_id = $1 order by created_at`, [run.id])).rows;
log("events + tickets", { alarms, tickets });
if (scenario === "late") log("sweep-back", { tx: (await sweep(db, ctx, run.id)).tx });

const lines = await getLines(db, run.id);
const decisions = (await db.query(`select idx, verdict, rev, reason_code, rules_fired, model, evidence_hash, tx, chain_status from decisions where run_id = $1 order by created_at`, [run.id])).rows;
const summary = {
  deployment: cfg.deployment,
  note: label === "FORK" ? "Anvil fork of Aevum 44005 — these hashes exist only on the local fork, never on the explorer." : undefined,
  scenario, run: run.id, runId: run.runId, brake: cfg.brake, model: model.id,
  lines: lines.map((l) => ({ line: l.idx + 1, invoice: l.invoice_id, amount: fromUnits(BigInt(l.amount_units)), status: l.status, paidTx: l.paid_tx, stopTx: l.stop_tx, proofTx: l.proof_tx, proofReason: l.proof_reason })),
  decisions, alarms, tickets, steps, totalMs: Date.now() - t0,
};
const out = join(REPO_ROOT, "evidence", `${scenario}-${cfg.deployment}.json`);
writeFileSync(out, JSON.stringify(JSON.parse(enc(summary)), null, 2) + "\n");
console.log(`\nwrote ${out}`);
console.table(summary.lines.map((l) => ({ line: l.line, invoice: l.invoice, amount: l.amount, status: l.status })));
await db.end();
