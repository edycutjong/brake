import { timingSafeEqual } from "node:crypto";
import { formatEther, type Hex } from "viem";
import { eip3009Abi } from "brake-signer";
import type { ChainCtx } from "./chain.js";
import { sha256, type Db } from "./db.js";
import type { ModelClient } from "./agent/model.js";
import { runReviewJobs } from "./jobs.js";
import { dueRuns, payday, sweep } from "./keeper.js";
import { reconcile } from "./reconciler.js";
import {
  createRun,
  deliver,
  financeDecide,
  getLines,
  getRun,
  HttpError,
  openRunOnChain,
  reissueLine,
  REVIEW_BUDGET,
  revokeAgent,
  runMessages,
  enqueueReview,
} from "./runs.js";

export interface ApiDeps {
  db: Db;
  ctx: ChainCtx;
  model: ModelClient;
  /** run work after the response (Next.js `after()` / waitUntil); defaults to fire-and-forget */
  defer?: (p: Promise<unknown>) => void;
  limits?: Partial<Limits>;
}

export interface Limits {
  runsPerIpPerHour: number;
  inboxPerRunPerHour: number;
  dailySpendUnits: bigint;
}

const DEFAULT_LIMITS: Limits = {
  runsPerIpPerHour: 3,
  inboxPerRunPerHour: 20,
  dailySpendUnits: BigInt(process.env.DAILY_SPEND_CAP_UNITS ?? 20_000_000), // 20 tUSD8 at SEED_SCALE 0.0001 ≈ 13 hero runs
};

/** tUSD8 signed into demo runs over the last 24 h (sweeps return it, but the cap bounds what one day can put at risk). */
const SPENT_TODAY = `select coalesce(sum(l.amount_units), 0)::text as s from lines l join runs r on r.id = l.run_id
  where r.created_at > now() - interval '1 day'`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

type Handler = (req: Request, p: Record<string, string>, d: Required<Omit<ApiDeps, "limits">> & { limits: Limits }) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "/?$"), h]);

/** Framework-agnostic fetch handler for every /api route (P1c mounts it in Next.js App Router route files). */
export function createApi(deps: ApiDeps) {
  const d = { defer: (p: Promise<unknown>) => void p.catch(() => {}), ...deps, limits: { ...DEFAULT_LIMITS, ...deps.limits } };
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const [method, re, h] of routes) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      try {
        return await h(req, m.groups ?? {}, d);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.body });
        return json(500, { error: "internal error", detail: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
    return json(404, { error: "no route" });
  };
}

// ------------------------------------------------------------------------------------------------- helpers

export function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

function bearer(req: Request) {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : (req.headers.get("x-brake-session") ?? undefined);
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function hasSession(req: Request, db: Db, id: string) {
  const t = bearer(req);
  if (!t) return false;
  const run = await getRun(db, id);
  return safeEq(sha256(t), run.session_hash);
}

async function requireSession(req: Request, db: Db, id: string) {
  if (!(await hasSession(req, db, id))) throw new HttpError(401, "session token required for this run");
}

/** Fixed-window counter in Postgres (functions are stateless). Returns false when the limit is hit. */
export async function hit(db: Db, key: string, limit: number, windowSec: number): Promise<boolean> {
  const r = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count`,
    [key, windowSec],
  );
  return r.rows[0]!.count <= limit;
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

const intParam = (s: string | undefined, name: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `bad ${name}`);
  return n;
};

// ---------------------------------------------------------------------------------------------------- runs

route("POST", "/api/runs", async (req, _p, { db, ctx, limits, defer, model }) => {
  const b = await body<{ scenario?: string; open?: boolean }>(req);
  const scenario = b.scenario ?? "hero";
  if (!(await hit(db, `runs:${clientIp(req)}`, limits.runsPerIpPerHour, 3600))) throw new HttpError(429, "≤ 3 demo runs per IP per hour");
  // global daily spend cap (rows in Postgres), then the payer's free liquidity after other unsettled runs' reservations
  const spent = await db.query<{ s: string }>(SPENT_TODAY);
  if (BigInt(spent.rows[0]!.s) >= limits.dailySpendUnits) throw new HttpError(429, "daily demo spend cap reached — try tomorrow");
  const res = await admit(db, ctx);
  if (!res.ok) {
    throw new HttpError(409, `a demo run is in progress, yours starts in ~${res.waitMin} min`, { busy: true, waitMin: res.waitMin });
  }
  const run = await createRun(db, ctx, { scenario, ip: clientIp(req) });
  if (b.open !== false) {
    defer(
      openRunOnChain(db, ctx, run.id).then(() => runReviewJobs(db, ctx, model, { runId: run.id })),
    );
  }
  return json(201, { id: run.id, runId: run.runId, token: run.token, validAfter: run.validAfter, validBefore: run.validBefore });
});

/** Admission: payer tUSD8 balance minus every unsettled run's reservation must cover a new hero-sized reservation. */
export async function admit(db: Db, ctx: ChainCtx) {
  const payer = ctx.wallets.payer?.account.address;
  if (!payer) throw new HttpError(503, "demo payer not configured");
  const bal = (await ctx.pub.readContract({ address: ctx.cfg.token, abi: eip3009Abi, functionName: "balanceOf", args: [payer] })) as bigint;
  const r = await db.query<{ reserved: string; n: string; oldest: Date | null }>(
    `select coalesce(sum(reserved_units), 0)::text as reserved, count(*)::text as n, min(created_at) as oldest from runs where settled_at is null and payer = $1`,
    [payer],
  );
  const need = BigInt((await db.query<{ s: string }>(`select coalesce(max(reserved_units), 0)::text as s from runs`)).rows[0]!.s) || 1_400_000n;
  const free = bal - BigInt(r.rows[0]!.reserved);
  return { ok: free >= need, free, need, waitMin: Math.max(1, 4 * Number(r.rows[0]!.n)) };
}

route("POST", "/api/runs/:id/open", async (req, p, { db, ctx }) => {
  await requireSession(req, db, p.id!);
  return json(200, await openRunOnChain(db, ctx, p.id!));
});

route("GET", "/api/runs/:id", async (req, p, { db, ctx }) => {
  const run = await getRun(db, p.id!);
  const session = await hasSession(req, db, p.id!);
  const lines = await getLines(db, p.id!);
  const decisions = (
    await db.query(
      `select d.idx, d.verdict, d.rev, d.reason_code, d.rules_fired, d.quotes, d.model, d.evidence_hash, d.tx, d.chain_status, d.created_at
         from decisions d where d.run_id = $1 order by d.created_at`,
      [p.id],
    )
  ).rows.map((x) => (session ? x : { ...x, quotes: undefined }));
  const jobs = (await db.query(`select id, trigger, status, attempts, error, created_at from review_jobs where run_id = $1 order by created_at`, [p.id])).rows;
  const vendors = (await db.query(`select vendor_id, name, domain, payee, payee_change_verified from run_vendors where run_id = $1`, [p.id])).rows;
  return json(200, {
    id: run.id,
    runId: run.run_id,
    scenario: run.scenario,
    payer: run.payer,
    agent: run.agent,
    agentId: run.agent_id,
    validAfter: run.valid_after,
    validBefore: run.valid_before,
    maxStops: run.max_stops,
    openTx: run.open_tx,
    sweepTx: run.sweep_tx,
    settledAt: run.settled_at,
    reviewsLeft: REVIEW_BUDGET.total - run.reviews_used,
    explorer: ctx.cfg.explorer,
    deployment: ctx.cfg.deployment,
    vendors,
    lines: lines.map((l) => ({
      idx: l.idx, vendorId: l.vendor_id, invoice: l.invoice_id, payee: l.payee, amountUnits: l.amount_units, status: l.status,
      validAfter: l.valid_after, evidenceRev: l.evidence_rev, paidTx: l.paid_tx, stopTx: l.stop_tx, proofTx: l.proof_tx,
      proofReason: l.proof_reason, reissuedFrom: l.reissued_from, requestHash: l.request_hash,
    })),
    decisions,
    jobs,
    session,
  });
});

route("POST", "/api/runs/:id/inbox", async (req, p, { db, ctx, defer, model, limits }) => {
  await requireSession(req, db, p.id!);
  if (!(await hit(db, `inbox:${p.id}`, limits.inboxPerRunPerHour, 3600))) throw new HttpError(429, "inbox rate limit for this run");
  const b = await body<{ seed?: string; vendor_id?: string; from_addr?: string; body?: string; subject?: string }>(req);
  const r = await deliver(db, ctx, p.id!, { seed: b.seed, vendorId: b.vendor_id, fromAddr: b.from_addr, body: b.body, subject: b.subject });
  if (r.jobId) defer(runReviewJobs(db, ctx, model, { runId: p.id! }));
  return json(202, {
    messageId: r.messageId,
    linkedLines: r.linkedLines,
    linked: r.linkedLines.length ? `linked to line(s) ${r.linkedLines.map((i) => i + 1).join(", ")}` : "not linked to any line",
    jobId: r.jobId,
    budgetSpent: r.budgetSpent,
    note: r.budgetSpent ? "review budget spent — the linked line is now stale and will be HELD at payday (fail-closed)" : undefined,
  });
});

route("GET", "/api/runs/:id/inbox", async (req, p, { db }) => {
  await requireSession(req, db, p.id!);
  return json(200, { messages: await runMessages(db, p.id!) });
});

route("POST", "/api/runs/:id/review", async (req, p, { db, ctx, defer, model }) => {
  await requireSession(req, db, p.id!);
  const r = await enqueueReview(db, p.id!, "manual");
  if (r.budgetSpent) throw new HttpError(429, "review budget spent (10 per run, 3 reserved for the scripted hero)", { budgetSpent: true });
  defer(runReviewJobs(db, ctx, model, { runId: p.id! }));
  return json(202, { jobId: r.jobId });
});

route("POST", "/api/runs/:id/payday", async (req, p, { db, ctx, defer }) => {
  await requireSession(req, db, p.id!);
  const sync = new URL(req.url).searchParams.get("wait") === "1";
  const work = payday(db, ctx, p.id!);
  if (sync) return json(200, await work);
  defer(work);
  return json(202, { queued: true });
});

route("POST", "/api/runs/:id/lines/:idx/decide", async (req, p, { db, ctx }) => {
  await requireSession(req, db, p.id!);
  const b = await body<{ action?: string; finding_id?: string }>(req);
  if (b.action !== "allow" && b.action !== "stop") throw new HttpError(400, "action must be allow or stop");
  return json(200, await financeDecide(db, ctx, p.id!, intParam(p.idx, "idx"), b.action, b.finding_id));
});

route("POST", "/api/runs/:id/lines/:idx/reissue", async (req, p, { db, ctx }) => {
  await requireSession(req, db, p.id!);
  return json(200, await reissueLine(db, ctx, p.id!, intParam(p.idx, "idx")));
});

route("POST", "/api/runs/:id/revoke", async (req, p, { db, ctx }) => {
  await requireSession(req, db, p.id!);
  return json(200, await revokeAgent(db, ctx, p.id!));
});

// ---------------------------------------------------------------------------------------------- evidence

route("GET", "/api/evidence/:hash", async (req, p, { db }) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.hash!)) throw new HttpError(400, "bad hash");
  const r = await db.query(`select run_id, idx, verdict, evidence from decisions where lower(evidence_hash) = lower($1) limit 1`, [p.hash]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, "unknown evidence hash");
  const session = await hasSession(req, db, row.run_id);
  const ev = row.evidence as { findings?: { quotes: { messageId: string; text: string }[] }[] };
  const composerIds = new Set(
    (await db.query<{ id: string }>(`select id from inbox where run_id = $1 and source = 'composer'`, [row.run_id])).rows.map((x) => x.id),
  );
  const hasPrivate = (ev.findings ?? []).some((f) => f.quotes.some((q) => composerIds.has(q.messageId)));
  if (hasPrivate && !session) {
    const redacted = {
      ...ev,
      findings: (ev.findings ?? []).map((f) => ({
        ...f,
        quotes: f.quotes.map((q) => (composerIds.has(q.messageId) ? { messageId: q.messageId, text: "[session-private]" } : q)),
      })),
    };
    return json(200, { hash: p.hash, redacted: true, label: "contains session-private quotes — full recompute needs the session token", evidence: redacted });
  }
  return json(200, { hash: p.hash, redacted: false, label: "authored demo data (seed emails written by the builder)", evidence: ev });
});

route("GET", "/api/verify/events", async (req, _p, { db, ctx }) => {
  const since = BigInt(new URL(req.url).searchParams.get("since") ?? "0");
  await maybeReconcile(db, ctx);
  const head = await ctx.pub.getBlockNumber();
  // Aevum (cdk-erigon): 'finalized' = the last verified batch, observed ~4.6k blocks behind 'latest' (evidence/finality-observation.json)
  const finalized = await ctx.pub.getBlock({ blockTag: "finalized" }).then((b) => b.number ?? 0n, () => 0n);
  const rows = (
    await db.query(
      `select tx_hash, log_index, block_number, address, name, run_id, idx, args from chain_events where block_number > $1
        order by block_number desc, log_index desc limit 200`,
      [since.toString()],
    )
  ).rows.map((e) => ({
    ...e,
    final: head - BigInt(e.block_number) >= BigInt(ctx.cfg.confirmations),
    finalized: BigInt(e.block_number) <= finalized,
    link: ctx.cfg.deployment === "live" ? ctx.explorerTx(e.tx_hash as Hex) : null,
  }));
  return json(200, { head, finalized, confirmations: ctx.cfg.confirmations, events: rows });
});

/** On-demand reconcile, at most once per 3 s across all viewers (Postgres-held timestamp + the reconciler's own lock). */
export async function maybeReconcile(db: Db, ctx: ChainCtx) {
  const r = await db.query(
    `insert into cursors (name, last_block) values ('reconcile_ms', $1)
     on conflict (name) do update set last_block = excluded.last_block where cursors.last_block < $1 - 3000
     returning last_block`,
    [Date.now()],
  );
  if (r.rowCount) await reconcile(db, ctx);
}

// ------------------------------------------------------------------------------------------- keeper + health

route("POST", "/api/keeper/tick", async (req, _p, { db, ctx, model }) => {
  const secret = ctx.cfg.cronSecret;
  const t = bearer(req);
  if (!secret || !t || !safeEq(t, secret)) throw new HttpError(401, "cron secret required");
  const jobs = await runReviewJobs(db, ctx, model, { max: 5 });
  const paydays = [];
  for (const id of await dueRuns(db)) {
    try {
      const p = await payday(db, ctx, id);
      const s = await sweep(db, ctx, id);
      paydays.push({ id, paid: p.paid.length, held: p.held.length, proofs: p.proofs.length, sweep: s.tx });
    } catch (e) {
      paydays.push({ id, error: String((e as Error).message).slice(0, 200) });
    }
  }
  const rec = await reconcile(db, ctx);
  await db.query(`insert into cursors (name, last_block) values ('last_tick_ms', $1) on conflict (name) do update set last_block = excluded.last_block`, [Date.now()]);
  return json(200, { jobs: jobs.length, paydays, reconciled: { to: rec.to, events: rec.events, updates: rec.updates.length, retried: rec.retried.length } });
});

route("GET", "/api/health", async (_req, _p, { db, ctx, limits }) => {
  const c = ctx.cfg;
  const [block, cursors, lastJob] = await Promise.all([
    ctx.pub.getBlockNumber(),
    db.query<{ name: string; last_block: string }>(`select name, last_block::text from cursors`),
    db.query(`select id, status, created_at, error from review_jobs order by created_at desc limit 1`),
  ]);
  const cur = Object.fromEntries(cursors.rows.map((r) => [r.name, r.last_block]));
  const bal = async (a?: Hex) =>
    a
      ? {
          address: a,
          tUSD8: ((await ctx.pub.readContract({ address: c.token, abi: eip3009Abi, functionName: "balanceOf", args: [a] })) as bigint).toString(),
          tQDAY: formatEther(await ctx.pub.getBalance({ address: a })),
        }
      : null;
  const spent = await db.query<{ s: string }>(SPENT_TODAY);
  return json(200, {
    ok: true,
    deployment: c.deployment,
    chainId: c.chainId,
    block,
    contracts: { brake: c.brake, token: c.token, identity: c.identity, validation: c.validation, multicall3: c.multicall3 },
    lastReconciledBlock: cur[`reconciler:${c.brake.toLowerCase()}`] ?? null,
    lastTick: cur.last_tick_ms ? new Date(Number(cur.last_tick_ms)).toISOString() : null,
    lastModelCall: cur.last_model_call ? new Date(Number(cur.last_model_call)).toISOString() : null,
    lastReviewJob: lastJob.rows[0] ?? null,
    payer: await bal(ctx.wallets.payer?.account.address),
    agent: await bal(ctx.wallets.agent?.account.address),
    keeper: await bal(ctx.wallets.keeper?.account.address),
    dailySpendCapLeftUnits: (limits.dailySpendUnits - BigInt(spent.rows[0]!.s)).toString(),
  });
});
