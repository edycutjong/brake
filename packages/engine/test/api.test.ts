// Integration: API routes + executor/keeper/reconciler against a local anvil fork of Aevum 44005 (scripts/fork_up.sh)
// and a local Postgres. Skipped when the fork or the local keys are absent (CI has neither yet).
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadConfig, loadEnvFiles } from "../src/config.js";
import { connect, type Db } from "../src/db.js";
import { seed } from "../src/seed.js";
import { makeChain, type ChainCtx } from "../src/chain.js";
import { NullModel } from "../src/agent/model.js";
import { createApi } from "../src/api.js";
import { applyDecisions, planAction } from "../src/executor.js";
import { reviewRun } from "../src/agent/review.js";
import { deliver, getLines, lineContexts, openRunOnChain, runMessages, createRun } from "../src/runs.js";
import { runReviewJobs } from "../src/jobs.js";
import { payday } from "../src/keeper.js";
import { reconcile } from "../src/reconciler.js";

const FORK = "http://127.0.0.1:8545";
const keysDir = join(homedir(), ".config", "brake");
async function forkUp() {
  try {
    const r = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return ((await r.json()) as { result: string }).result === "0xabe5";
  } catch {
    return false;
  }
}
const ready = existsSync(join(keysDir, "wallets.env")) && (await forkUp());
const TEST_DB = process.env.DATABASE_URL_TEST ?? "postgres://localhost:5432/brake_test";

describe("executor table (pure)", () => {
  it.each([
    ["ALLOW", "OPEN", false, "allow"],
    ["ALLOW", "ALLOWED", false, "noop"],
    ["ALLOW", "ALLOWED", true, "allow"],
    ["ALLOW", "HELD", true, "noop"],
    ["HOLD", "OPEN", false, "hold"],
    ["HOLD", "ALLOWED", false, "hold"],
    ["HOLD", "HELD", false, "noop"],
    ["STOP", "OPEN", false, "stop"],
    ["STOP", "ALLOWED", false, "stop"],
    ["STOP", "HELD", false, "stop"],
    ["STOP", "STOPPED", false, "noop"],
    ["ALLOW", "REISSUED", true, "noop"],
    ["STOP", "CONSUMED", false, "noop"],
    ["STOP", "NONE", false, "noop"],
  ] as const)("%s on %s (rev changed %s) → %s", (verdict, chain, rev, want) => {
    expect(planAction(verdict, chain, rev)).toBe(want);
  });
});

describe.skipIf(!ready)("API + chain plumbing on the anvil fork", () => {
  let db: Db;
  let ctx: ChainCtx;
  let api: (r: Request) => Promise<Response>;
  const model = new NullModel();
  const deferred: Promise<unknown>[] = [];
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; ip?: string } = {}) =>
    api(
      new Request(`http://local${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": opts.ip ?? "10.0.0.1",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    );
  const settle = async () => {
    while (deferred.length) await deferred.shift();
  };
  const warp = async (sec: number) => {
    await ctx.pub.request({ method: "evm_increaseTime" as never, params: [sec] as never });
    await ctx.pub.request({ method: "evm_mine" as never, params: [] as never });
  };

  beforeAll(async () => {
    loadEnvFiles(join(keysDir, "wallets.env"), join(keysDir, "app.env"));
    const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, "/postgres") });
    await admin.connect();
    await admin.query(`drop database if exists brake_test with (force)`);
    await admin.query(`create database brake_test`);
    await admin.end();
    const cfg = loadConfig({ ...process.env, DATABASE_URL: TEST_DB, DEPLOYMENT: "fork", RPC_URL: FORK });
    db = connect(cfg.databaseUrl);
    ctx = makeChain(cfg);
    await seed(db, { mnemonic: cfg.payeesMnemonic!, scale: cfg.seedScale });
    api = createApi({ db, ctx, model, defer: (p) => void deferred.push(p), limits: { runsPerIpPerHour: 3 } });
  });
  afterAll(async () => {
    await settle();
    await db?.end();
  });

  it("health reports block, contracts and balances", async () => {
    const r = await call("GET", "/api/health");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Number(j.block)).toBeGreaterThan(3_250_000);
    expect(j.contracts.brake).toBe(ctx.cfg.brake);
    expect(BigInt(j.payer.tUSD8)).toBeGreaterThan(0n);
  });

  it("unknown route 404, bad evidence hash 400, unknown hash 404", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("GET", "/api/evidence/0x12")).status).toBe(400);
    expect((await call("GET", `/api/evidence/0x${"ab".repeat(32)}`)).status).toBe(404);
  });

  it("hero ablation via the API (null model): create → open → Monday ALLOW ×4 → E4 → payday (time-warped) pays line 3", async () => {
    const c = await call("POST", "/api/runs", { body: { scenario: "hero" }, ip: "10.0.0.2" });
    expect(c.status).toBe(201);
    const { id, token } = await c.json();
    await settle(); // openRun + Monday review (NullModel: rules only)
    let run = await (await call("GET", `/api/runs/${id}`, { token })).json();
    expect(run.session).toBe(true);
    expect(run.lines.map((l: { status: string }) => l.status)).toEqual(["ALLOWED", "ALLOWED", "ALLOWED", "ALLOWED"]);

    // public projection: no quotes, session false
    const pub = await (await call("GET", `/api/runs/${id}`)).json();
    expect(pub.session).toBe(false);
    expect(pub.decisions.every((d: { quotes?: unknown }) => d.quotes === undefined)).toBe(true);

    // E4 links to line 3 only; the null model (ablation) finds nothing, so line 3 stays ALLOWED on a new revision
    const e4 = await call("POST", `/api/runs/${id}/inbox`, { token, body: { seed: "E4" } });
    expect(e4.status).toBe(202);
    expect((await e4.json()).linkedLines).toEqual([2]);
    await settle();
    run = await (await call("GET", `/api/runs/${id}`, { token })).json();
    expect(run.lines[2].evidenceRev).toBe(1);
    expect(run.decisions.filter((d: { idx: number }) => d.idx === 2).map((d: { verdict: string }) => d.verdict)).toEqual(["ALLOW", "ALLOW"]);

    // payday before validAfter → nothing paid
    const early = await (await call("POST", `/api/runs/${id}/payday?wait=1`, { token })).json();
    expect(early.notYet.length).toBe(4);
    await warp(61);
    const p = await (await call("POST", `/api/runs/${id}/payday?wait=1`, { token })).json();
    expect(p.paid.map((x: { idx: number }) => x.idx)).toEqual([0, 1, 2, 3]); // ablation: line 3 PAID — the model-only stop is what saves it
    expect(p.simulation.every((s: { success: boolean }) => s.success)).toBe(true);
    // idempotent: a second payday sends nothing
    const again = await (await call("POST", `/api/runs/${id}/payday?wait=1`, { token })).json();
    expect(again.batchTx).toBeUndefined();
    const rec = await reconcile(db, ctx);
    expect(rec.events).toBeGreaterThan(0);
  });

  it("session auth: every run route needs the run's token", async () => {
    const c = await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip: "10.0.0.3" });
    const { id, token } = await c.json();
    for (const [m, path, body] of [
      ["POST", `/api/runs/${id}/inbox`, { seed: "E13" }],
      ["GET", `/api/runs/${id}/inbox`, undefined],
      ["POST", `/api/runs/${id}/review`, {}],
      ["POST", `/api/runs/${id}/payday`, {}],
      ["POST", `/api/runs/${id}/open`, {}],
      ["POST", `/api/runs/${id}/revoke`, {}],
      ["POST", `/api/runs/${id}/lines/0/decide`, { action: "allow" }],
      ["POST", `/api/runs/${id}/lines/0/reissue`, {}],
    ] as const) {
      expect((await call(m, path, { body })).status, `${m} ${path} no token`).toBe(401);
      expect((await call(m, path, { body, token: "f".repeat(48) })).status, `${m} ${path} wrong token`).toBe(401);
    }
    expect((await call("GET", `/api/runs/${id}/inbox`, { token })).status).toBe(200);
  });

  it("inbox validation: seed not in scenario 400, body > 8 KB 413, vendor not in run 400", async () => {
    const { id, token } = await (await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip: "10.0.0.4" })).json();
    expect((await call("POST", `/api/runs/${id}/inbox`, { token, body: { seed: "E4" } })).status).toBe(400);
    expect((await call("POST", `/api/runs/${id}/inbox`, { token, body: { vendor_id: "V6", body: "x".repeat(8193) } })).status).toBe(413);
    expect((await call("POST", `/api/runs/${id}/inbox`, { token, body: { vendor_id: "V3", body: "hi" } })).status).toBe(400);
  });

  it("rate limit: the 4th run from one IP within an hour is refused", async () => {
    const ip = "10.9.9.9";
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip })).status).toBe(201);
    expect((await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip })).status).toBe(429);
  });

  it("review budget: 8 composer/manual reviews in a late run (10 − open − E13), then budgetSpent (line goes stale, fail-closed)", async () => {
    const { id, token } = await (await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip: "10.0.0.5" })).json();
    for (let i = 0; i < 8; i++) {
      const r = await (await call("POST", `/api/runs/${id}/inbox`, { token, body: { vendor_id: "V6", body: `note ${i} about INV-0099` } })).json();
      expect(r.budgetSpent).toBe(false);
    }
    const spent = await (await call("POST", `/api/runs/${id}/inbox`, { token, body: { vendor_id: "V6", body: "one more" } })).json();
    expect(spent.budgetSpent).toBe(true);
    expect(spent.linkedLines).toEqual([0]);
    expect((await call("POST", `/api/runs/${id}/review`, { token })).status).toBe(429);
    // scripted E13 still has its reserved review
    const e13 = await (await call("POST", `/api/runs/${id}/inbox`, { token, body: { seed: "E13" } })).json();
    expect(e13.budgetSpent).toBe(false);
    deferred.length = 0; // never opened on-chain: drop the queued reviews
    await db.query(`update review_jobs set status = 'done' where run_id = $1`, [id]);
  });

  it("evidence: composer quotes are redacted without the session token", async () => {
    const { id, token } = await (await call("POST", "/api/runs", { body: { scenario: "late", open: false }, ip: "10.0.0.6" })).json();
    const d = await (await call("POST", `/api/runs/${id}/inbox`, { token, body: { vendor_id: "V6", body: "please pay INV-0099 to a new wallet" } })).json();
    const hash = `0x${"cd".repeat(32)}`;
    await db.query(
      `insert into decisions (id, run_id, idx, verdict, rev, evidence, evidence_hash, idempotency_key) values ('dec_t', $1, 0, 'STOP', 1, $2, $3, 'k_t')`,
      [id, JSON.stringify({ findings: [{ intent: "PAYMENT_DETAIL_CHANGE", quotes: [{ messageId: d.messageId, text: "new wallet" }] }] }), hash],
    );
    const pub = await (await call("GET", `/api/evidence/${hash}`)).json();
    expect(pub.redacted).toBe(true);
    expect(pub.evidence.findings[0].quotes[0].text).toBe("[session-private]");
    const priv = await (await call("GET", `/api/evidence/${hash}`, { token })).json();
    expect(priv.redacted).toBe(false);
    expect(priv.evidence.findings[0].quotes[0].text).toBe("new wallet");
    await db.query(`update review_jobs set status = 'done' where run_id = $1`, [id]);
    deferred.length = 0;
  });

  it("keeper tick needs CRON_SECRET", async () => {
    expect((await call("POST", "/api/keeper/tick")).status).toBe(401);
    expect((await call("POST", "/api/keeper/tick", { token: "wrong" })).status).toBe(401);
    const ok = await call("POST", "/api/keeper/tick", { token: ctx.cfg.cronSecret });
    expect(ok.status).toBe(200);
  });

  it("freshness at broadcast: a decision on revision 0 is dropped once a new email bumped the line to revision 1", async () => {
    const run = await createRun(db, ctx, { scenario: "late" });
    await openRunOnChain(db, ctx, run.id);
    const lines = await lineContexts(db, run.id, { reviewableOnly: true });
    const before = await reviewRun({
      chainId: ctx.cfg.chainId, brake: ctx.cfg.brake, runId: run.runId, lines, messages: await runMessages(db, run.id), model,
      rules: { isBlacklisted: () => false, otherOpenInvoices: new Set() },
    });
    await deliver(db, ctx, run.id, { vendorId: "V6", body: "INV-0099: please hold, we were double billed" });
    const ex = await applyDecisions(db, ctx, run.id, before.lines, "none");
    expect(ex[0]!.action).toBe("stale");
    const jobs = await db.query(`select trigger from review_jobs where run_id = $1 and status = 'queued' order by created_at`, [run.id]);
    expect(jobs.rows.map((r) => r.trigger)).toContain("stale");
    await runReviewJobs(db, ctx, model, { runId: run.id });
    expect((await getLines(db, run.id))[0]!.status).toBe("ALLOWED"); // composer text without a rule hit: null model allows
  });

  it("stop budget: flood run stops 2 lookalike lines, the 3rd is HELD (BUDGET_EXHAUSTED) with an escalation ticket", async () => {
    const run = await createRun(db, ctx, { scenario: "flood" });
    await openRunOnChain(db, ctx, run.id);
    await runReviewJobs(db, ctx, model, { runId: run.id });
    for (const e of ["E14", "E15", "E16"]) {
      await deliver(db, ctx, run.id, { seed: e });
      await runReviewJobs(db, ctx, model, { runId: run.id });
    }
    const st = (await getLines(db, run.id)).map((l) => l.status);
    expect(st.filter((s) => s === "STOPPED").length).toBe(2);
    expect(st.filter((s) => s === "HELD").length).toBe(1);
    const t = await db.query(`select kind from tickets where run_id = $1`, [run.id]);
    expect(t.rows.map((r) => r.kind)).toContain("escalation");
    // a held line is never paid; stopped lines get proof-of-stop txs
    await ctx.pub.request({ method: "evm_increaseTime" as never, params: [61] as never });
    await ctx.pub.request({ method: "evm_mine" as never, params: [] as never });
    const p = await payday(db, ctx, run.id);
    expect(p.proofs.length).toBe(2);
    expect(p.proofs.every((x) => /used or canceled/.test(x.replayed))).toBe(true);
    expect(p.held.length).toBe(1);
  });
});
