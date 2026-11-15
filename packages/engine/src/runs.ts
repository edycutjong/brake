import { randomBytes } from "node:crypto";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { brakeAbi, signPair, signRun, type SignedPair } from "brake-signer";
import { sendQueued, wallet, type ChainCtx } from "./chain.js";
import { lock, newId, open as unseal, seal, sha256, withTx, type Db, type Tx } from "./db.js";
import { fill, fromUnits, mailTemplates, payeeAddress, runFixtures, templateTime, vendorFixtures } from "./fixtures.js";
import type { LineCtx, Message } from "./agent/types.js";

/** Off-chain line statuses (the chain's Brake status is read separately). */
export const TERMINAL = ["STOPPED", "CONSUMED", "TOO_LATE", "EXTERNALLY_CANCELLED", "PAID", "REISSUED", "FAILED", "EXPIRED"];

export interface RunRow {
  id: string;
  run_id: Hex;
  scenario: string;
  payer: Address;
  agent: Address;
  agent_id: string;
  valid_after: Date;
  valid_before: Date;
  max_stops: number;
  alarm_at: number;
  open_tx: Hex | null;
  session_hash: string;
  reviews_used: number;
  reserved_units: string;
  settled_at: Date | null;
  sweep_tx: Hex | null;
  created_at: Date;
}

export interface LineRow {
  run_id: string;
  idx: number;
  vendor_id: string;
  invoice_id: string;
  payee: Address;
  amount_units: string;
  nonce: Hex;
  request_hash: Hex | null;
  status: string;
  valid_after: Date;
  valid_before: Date;
  window_start: Date;
  paid_tx: Hex | null;
  stop_tx: Hex | null;
  proof_tx: Hex | null;
  proof_reason: string | null;
  reissued_from: number | null;
  evidence_rev: number;
  payee_idx: number | null;
}

export async function getRun(db: Db | Tx, id: string): Promise<RunRow> {
  const r = await db.query<RunRow>(`select * from runs where id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, "run not found");
  return r.rows[0];
}

export async function getLines(db: Db | Tx, id: string): Promise<LineRow[]> {
  return (await db.query<LineRow>(`select * from lines where run_id = $1 order by idx`, [id])).rows;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function chainNow(ctx: ChainCtx): Promise<bigint> {
  return (await ctx.pub.getBlock({ blockTag: "latest" })).timestamp;
}

export const lineTotal = (amounts: bigint[]) => amounts.reduce((a, b) => a + b, 0n);

/** Liquidity a run can draw: every line, plus its largest line once more for a possible re-issue. */
export const reservation = (amounts: bigint[]) => lineTotal(amounts) + amounts.reduce((m, a) => (a > m ? a : m), 0n);

// --------------------------------------------------------------------------------------------- signatures

function aad(runId: string, idx: number, kind: string) {
  return `${runId}:${idx}:${kind}`;
}

async function storePair(c: Tx, key: string, runRowId: string, idx: number, pair: SignedPair) {
  const auth = {
    ...pair.authorization,
    value: pair.authorization.value.toString(),
    validAfter: pair.authorization.validAfter.toString(),
    validBefore: pair.authorization.validBefore.toString(),
  };
  for (const kind of ["payment", "cancel"] as const) {
    const s = seal(key, JSON.stringify({ authorization: auth, sig: pair[kind] }), aad(runRowId, idx, kind));
    await c.query(
      `insert into signatures (run_id, idx, kind, ciphertext, iv, tag) values ($1,$2,$3,$4,$5,$6)
       on conflict (run_id, idx, kind) do update set ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag`,
      [runRowId, idx, kind, s.ciphertext, s.iv, s.tag],
    );
  }
}

export interface StoredSig {
  authorization: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
  sig: { v: number; r: Hex; s: Hex; signature: Hex };
}

/** Executor/keeper only — the agent module never imports this (invariant I1). */
export async function loadSig(db: Db | Tx, key: string, runRowId: string, idx: number, kind: "payment" | "cancel"): Promise<StoredSig> {
  const r = await db.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
    `select ciphertext, iv, tag from signatures where run_id = $1 and idx = $2 and kind = $3`,
    [runRowId, idx, kind],
  );
  if (!r.rows[0]) throw new Error(`no ${kind} signature for ${runRowId}#${idx}`);
  const j = JSON.parse(unseal(key, r.rows[0], aad(runRowId, idx, kind)));
  const a = j.authorization;
  return {
    authorization: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
    sig: j.sig,
  };
}

// ---------------------------------------------------------------------------------------------- creation

export interface CreateRunResult {
  id: string;
  runId: Hex;
  token: string;
  validAfter: bigint;
  validBefore: bigint;
}

/** Template variables for a run's inbox copies (wallet addresses + scaled amounts). */
export function templateVars(mnemonic: string, amounts: Record<string, bigint>): Record<string, string> {
  const fraud = payeeAddress(mnemonic, 66);
  const vars: Record<string, string> = {
    fraud_wallet: fraud,
    last4_fraud: fraud.slice(-4),
    genuine_wallet: payeeAddress(mnemonic, 3),
    inject_amount: fromUnits(amounts["INV-8812"] ?? 0n),
  };
  for (const [inv, u] of Object.entries(amounts)) vars[`amount_${inv}`] = fromUnits(u);
  return vars;
}

/**
 * Create a demo run from the seeded vendors only: snapshot vendors + invoices, sign every line's payment and its paired
 * cancel with the demo payer (sealed at rest), copy the scenario's inbox templates with run-relative timestamps.
 */
export async function createRun(
  db: Db,
  ctx: ChainCtx,
  opts: { scenario: string; ip?: string; now?: Date },
): Promise<CreateRunResult> {
  const fx = runFixtures()[opts.scenario];
  if (!fx) throw new HttpError(400, `unknown scenario ${opts.scenario}`);
  const { cfg } = ctx;
  if (!cfg.sigEncKey || !cfg.payeesMnemonic) throw new Error("SIG_ENC_KEY / PAYEES_MNEMONIC missing");
  const payer = wallet(ctx, "payer");
  const agent = (ctx.wallets.agent?.account.address ?? process.env.AGENT_ADDRESS) as Address;
  if (!agent) throw new Error("agent address unknown");
  const now = opts.now ?? new Date();
  const t = await chainNow(ctx);
  const validAfter = t + BigInt(fx.paydayDelaySec);
  const validBefore = validAfter + BigInt(fx.windowHours * 3600);
  const vendorFx = new Map(vendorFixtures().map((v) => [v.id, v]));

  const id = newId("run");
  const runId = keccak256(toHex(`${id}:${randomBytes(8).toString("hex")}`));
  const token = randomBytes(24).toString("hex");

  return withTx(db, async (c) => {
    const snap = await c.query(
      `select v.*, v.id as vendor_id, i.id as invoice_id, i.amount_units, i.status as invoice_status
         from invoices i join vendors v on v.id = i.vendor_id where i.id = any($1)`,
      [fx.lines],
    );
    const byInv = new Map(snap.rows.map((r) => [r.invoice_id as string, r]));
    const lines = fx.lines.map((inv) => {
      const r = byInv.get(inv);
      if (!r) throw new Error(`invoice ${inv} not seeded — run pnpm seed`);
      return { inv, vendorId: r.vendor_id as string, payee: r.payee as Address, amount: BigInt(r.amount_units) };
    });
    const amounts = lines.map((l) => l.amount);
    const pairs = await signRun(payer.account, await ctx.domain(), {
      validAfter,
      validBefore,
      lines: lines.map((l) => ({ to: l.payee, value: l.amount })),
    });

    await c.query(
      `insert into runs (id, run_id, scenario, payer, agent, agent_id, valid_after, valid_before, max_stops, alarm_at,
         session_hash, demo, reserved_units, creator_ip, created_at)
       values ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),$9,$10,$11,true,$12,$13,$14)`,
      [
        id, runId, opts.scenario, payer.account.address, agent, cfg.agentId.toString(), Number(validAfter),
        Number(validBefore), fx.maxStops, fx.alarmAt, sha256(token), reservation(amounts).toString(), opts.ip ?? null, now,
      ],
    );
    const vendorIds = [...new Set(lines.map((l) => l.vendorId))];
    await c.query(
      `insert into run_vendors (run_id, vendor_id, name, domain, payee, genuine_payee, payee_changed_at, payee_change_source,
         payee_change_verified, payee_change_verified_by, contract_contact)
       select $1, id, name, domain, payee, genuine_payee, payee_changed_at, payee_change_source, payee_change_verified,
         payee_change_verified_by, contract_contact from vendors where id = any($2)`,
      [id, vendorIds],
    );
    await c.query(
      `insert into run_invoices (run_id, invoice_id, vendor_id, amount_units, status)
       select $1, id, vendor_id, amount_units, status from invoices where id = any($2)`,
      [id, fx.lines],
    );
    for (const [idx, l] of lines.entries()) {
      const vf = vendorFx.get(l.vendorId);
      await c.query(
        `insert into lines (run_id, idx, vendor_id, invoice_id, payee, amount_units, nonce, status, valid_after, valid_before,
           window_start, payee_idx)
         values ($1,$2,$3,$4,$5,$6,$7,'SIGNED',to_timestamp($8),to_timestamp($9),$10,$11)`,
        [id, idx, l.vendorId, l.inv, l.payee, l.amount.toString(), pairs[idx]!.authorization.nonce, Number(validAfter),
          Number(validBefore), now, vf?.payeeIdx ?? null],
      );
      await storePair(c, cfg.sigEncKey!, id, idx, pairs[idx]!);
    }
    const vars = templateVars(cfg.payeesMnemonic!, Object.fromEntries(lines.map((l) => [l.inv, l.amount])));
    for (const tpl of mailTemplates().filter((m) => fx.copy.includes(m.id))) {
      const at = templateTime(tpl.at, now) ?? now;
      await c.query(
        `insert into inbox (id, run_id, seed_id, from_addr, from_domain, subject, body, source, received_at)
         values ($1,$2,$3,$4,$5,$6,$7,'seed',$8)`,
        [newId("msg"), id, tpl.id, tpl.from, tpl.from.split("@")[1] ?? "", fill(tpl.subject, vars), fill(tpl.body, vars), at],
      );
    }
    return { id, runId, token, validAfter, validBefore };
  });
}

/** Payer registers the signed run in Brake (agentId binding, budget, expiry), then the first review is queued. */
export async function openRunOnChain(db: Db, ctx: ChainCtx, id: string) {
  const run = await getRun(db, id);
  if (run.open_tx) return { tx: run.open_tx as Hex, reused: true };
  const lines = await getLines(db, id);
  const data = encodeFunctionData({
    abi: brakeAbi,
    functionName: "openRun",
    args: [
      run.run_id,
      BigInt(run.agent_id),
      run.agent,
      BigInt(Math.floor(run.valid_before.getTime() / 1000)),
      run.max_stops,
      run.alarm_at,
      BigInt(Math.floor(run.valid_after.getTime() / 1000)),
      BigInt(Math.floor(run.valid_before.getTime() / 1000)),
      lines.map((l) => ({ payee: l.payee, amount: BigInt(l.amount_units), nonce: l.nonce })),
    ],
  });
  const tx = await sendQueued(db, ctx, {
    role: "payer",
    runId: id,
    action: "openRun",
    idempotencyKey: `${id}:openRun`,
    to: ctx.cfg.brake,
    data,
  });
  if (tx.status !== "mined") throw new Error(`openRun reverted: ${tx.hash}`);
  for (const l of lines) {
    const rh = (await ctx.pub.readContract({
      address: ctx.cfg.brake,
      abi: brakeAbi,
      functionName: "requestHashOf",
      args: [run.run_id, BigInt(l.idx)],
    })) as Hex;
    await db.query(`update lines set status = 'OPEN', request_hash = $3 where run_id = $1 and idx = $2 and status = 'SIGNED'`, [
      id, l.idx, rh,
    ]);
  }
  await db.query(`update runs set open_tx = $2 where id = $1`, [id, tx.hash]);
  await enqueueReview(db, id, "open");
  return { tx: tx.hash, reused: tx.reused };
}

// --------------------------------------------------------------------------------------------------- inbox

export const REVIEW_BUDGET = { total: 10 };
const isScripted = (trigger: string) => trigger === "open" || trigger.startsWith("seed:");

/**
 * Queue a review. Each run has 10. Scripted triggers — the open review and each of the scenario's scripted deliveries
 * (hero: E4, E5) — have reserved reviews (once each); composer emails, manual re-runs and stale re-reviews share the rest,
 * so a judge can never spend the hero's reviews. A spent budget leaves the bumped line stale → HELD at payday.
 */
export async function enqueueReview(db: Db | Tx, id: string, trigger: string): Promise<{ jobId: string | null; budgetSpent: boolean }> {
  const run = await getRun(db, id);
  const reserved = 1 + (runFixtures()[run.scenario]?.deliver.length ?? 0);
  if (isScripted(trigger)) {
    const dup = await db.query(`select 1 from review_jobs where run_id = $1 and trigger = $2`, [id, trigger]);
    if (dup.rowCount) return { jobId: null, budgetSpent: false };
  } else {
    const other = await db.query<{ n: string }>(
      `select count(*)::text as n from review_jobs where run_id = $1 and trigger <> 'open' and trigger not like 'seed:%'`,
      [id],
    );
    if (Number(other.rows[0]!.n) >= REVIEW_BUDGET.total - reserved) return { jobId: null, budgetSpent: true };
  }
  const jobId = newId("job");
  await db.query(`insert into review_jobs (id, run_id, trigger, status) values ($1,$2,$3,'queued')`, [jobId, id, trigger]);
  await db.query(`update runs set reviews_used = reviews_used + 1 where id = $1`, [id]);
  return { jobId, budgetSpent: false };
}

export interface DeliverInput {
  seed?: string;
  vendorId?: string;
  fromAddr?: string;
  body?: string;
  subject?: string;
}

/**
 * Add an email to THIS run only. Linked lines get a new evidence revision under the per-run lock (so a queued action
 * decided on the old revision is dropped at broadcast), then a review is queued.
 */
export async function deliver(db: Db, ctx: ChainCtx, id: string, input: DeliverInput) {
  const run = await getRun(db, id);
  let msg: { seedId: string | null; vendorId: string | null; from: string; subject: string; body: string; source: string };
  if (input.seed) {
    const fx = runFixtures()[run.scenario]!;
    if (!fx.deliver.includes(input.seed)) throw new HttpError(400, `${input.seed} is not deliverable in a ${run.scenario} run`);
    const tpl = mailTemplates().find((m) => m.id === input.seed)!;
    const lines = await getLines(db, id);
    const vars = templateVars(
      ctx.cfg.payeesMnemonic!,
      Object.fromEntries(lines.filter((l) => l.reissued_from === null).map((l) => [l.invoice_id, BigInt(l.amount_units)])),
    );
    msg = { seedId: tpl.id, vendorId: null, from: tpl.from, subject: fill(tpl.subject, vars), body: fill(tpl.body, vars), source: "seed" };
  } else {
    if (!input.vendorId || !input.body) throw new HttpError(400, "composer needs vendor_id and body");
    if (Buffer.byteLength(input.body) > 8192) throw new HttpError(413, "body max 8 KB");
    const v = await db.query(`select domain from run_vendors where run_id = $1 and vendor_id = $2`, [id, input.vendorId]);
    if (!v.rows[0]) throw new HttpError(400, "vendor not in this run");
    const from = (input.fromAddr ?? `billing@${v.rows[0].domain}`).slice(0, 200);
    msg = { seedId: null, vendorId: input.vendorId, from, subject: (input.subject ?? "(composer)").slice(0, 200), body: input.body, source: "composer" };
  }
  const result = await withTx(db, async (c) => {
    await lock(c, `run:${id}`);
    const msgId = newId("msg");
    const now = new Date();
    await c.query(
      `insert into inbox (id, run_id, seed_id, vendor_id, from_addr, from_domain, subject, body, source, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [msgId, id, msg.seedId, msg.vendorId, msg.from, msg.from.split("@")[1] ?? "", msg.subject, msg.body, msg.source, now],
    );
    // link against every line a review would read (incl. SIGNED before openRun), so no message slips past a revision bump
    const reviewable = new Set((await lineContexts(c, id, { reviewableOnly: true })).map((l) => l.idx));
    const ctxLines = (await lineContexts(c, id)).filter((l) => l.status === "SIGNED" || reviewable.has(l.idx));
    const { linkMessages } = await import("./agent/pipeline.js");
    const linked = linkMessages(ctxLines, [
      { id: msgId, fromAddr: msg.from, fromDomain: msg.from.split("@")[1] ?? "", subject: msg.subject, body: msg.body, receivedAt: now, vendorId: msg.vendorId },
    ]);
    const linkedIdx = [...linked.entries()].filter(([, m]) => m.length > 0).map(([i]) => i);
    if (linkedIdx.length) {
      await c.query(`update lines set evidence_rev = evidence_rev + 1 where run_id = $1 and idx = any($2)`, [id, linkedIdx]);
    }
    const job = await enqueueReview(c, id, input.seed ? `seed:${input.seed}` : "composer");
    return { messageId: msgId, linkedLines: linkedIdx, ...job };
  });
  return result;
}

/** Build the agent's view of the run's lines (vendor snapshot + ledger), never signatures. */
export async function lineContexts(db: Db | Tx, id: string, opts: { reviewableOnly?: boolean } = {}): Promise<LineCtx[]> {
  const r = await db.query(
    `select l.*, v.name, v.domain, v.payee as v_payee, v.genuine_payee, v.payee_changed_at, v.payee_change_source,
            v.payee_change_verified, i.amount_units as inv_amount, i.status as inv_status
       from lines l join run_vendors v on v.run_id = l.run_id and v.vendor_id = l.vendor_id
       join run_invoices i on i.run_id = l.run_id and i.invoice_id = l.invoice_id
      where l.run_id = $1 order by l.idx`,
    [id],
  );
  return r.rows
    // reviewable: undecided/allowed/held lines, plus PAID lines still inside their window — Brake only learns of a
    // payment when a stop is attempted, so a late risk signal must still produce a stop, which lands as CONSUMED → TOO_LATE
    .filter(
      (x) =>
        !opts.reviewableOnly ||
        ["OPEN", "ALLOWED", "HELD"].includes(x.status) ||
        (x.status === "PAID" && x.reissued_from === null && new Date(x.valid_before).getTime() > Date.now()),
    )
    .map((x) => ({
      idx: x.idx,
      vendor: {
        id: x.vendor_id,
        name: x.name,
        domain: x.domain,
        payee: x.v_payee,
        genuinePayee: x.genuine_payee,
        payeeChangedAt: x.payee_changed_at,
        payeeChangeSource: x.payee_change_source,
        payeeChangeVerified: x.payee_change_verified,
      },
      invoiceId: x.invoice_id,
      invoiceAmountUnits: BigInt(x.inv_amount),
      invoiceStatus: x.inv_status,
      payee: x.payee,
      amountUnits: BigInt(x.amount_units),
      nonce: x.nonce,
      status: x.status,
      evidenceRev: x.evidence_rev,
      windowStart: x.window_start,
    }));
}

export async function runMessages(db: Db | Tx, id: string): Promise<(Message & { vendorId: string | null; source: string })[]> {
  const r = await db.query(
    `select id, from_addr, from_domain, subject, body, received_at, vendor_id, source from inbox where run_id = $1 order by received_at`,
    [id],
  );
  return r.rows.map((m) => ({
    id: m.id,
    fromAddr: m.from_addr,
    fromDomain: m.from_domain,
    subject: m.subject,
    body: m.body,
    receivedAt: m.received_at,
    vendorId: m.vendor_id,
    source: m.source,
  }));
}

// ------------------------------------------------------------------------------------------ finance actions

/**
 * Finance re-issues a stopped line to the run snapshot's genuine (phone-verified) payee at ≤ the original amount: a fresh
 * payment + paired cancel, `Brake.reissue` (own window), then payer `allow` → FINANCE_ALLOW receipt.
 */
export async function reissueLine(db: Db, ctx: ChainCtx, id: string, oldIdx: number, opts: { delaySec?: number } = {}) {
  const run = await getRun(db, id);
  const lines = await getLines(db, id);
  const old = lines.find((l) => l.idx === oldIdx);
  if (!old) throw new HttpError(404, "line not found");
  const existing = lines.find((l) => l.reissued_from === oldIdx);
  if (existing) return { newIdx: existing.idx, reused: true, reissueTx: null as Hex | null, allowTx: null as Hex | null };
  if (old.status !== "STOPPED") throw new HttpError(409, `line ${oldIdx} is ${old.status}, only STOPPED lines can be re-issued`);
  const v = (await db.query(`select genuine_payee from run_vendors where run_id = $1 and vendor_id = $2`, [id, old.vendor_id])).rows[0];
  const payee = v.genuine_payee as Address;
  const fx = runFixtures()[run.scenario]!;
  const t = await chainNow(ctx);
  const validAfter = t + BigInt(opts.delaySec ?? fx.paydayDelaySec);
  const validBefore = validAfter + BigInt(fx.windowHours * 3600);
  const payer = wallet(ctx, "payer");
  const pair = await signPair(payer.account, await ctx.domain(), { to: payee, value: BigInt(old.amount_units), validAfter, validBefore });
  const newIdx = lines.length;
  const data = encodeFunctionData({
    abi: brakeAbi,
    functionName: "reissue",
    args: [run.run_id, BigInt(oldIdx), { payee, amount: BigInt(old.amount_units), nonce: pair.authorization.nonce }, validAfter, validBefore],
  });
  const now = new Date();
  await withTx(db, async (c) => {
    await lock(c, `run:${id}`);
    await c.query(
      `insert into lines (run_id, idx, vendor_id, invoice_id, payee, amount_units, nonce, status, valid_after, valid_before,
         window_start, reissued_from, payee_idx)
       values ($1,$2,$3,$4,$5,$6,$7,'SIGNED',to_timestamp($8),to_timestamp($9),$10,$11,$12)`,
      [id, newIdx, old.vendor_id, old.invoice_id, payee, old.amount_units, pair.authorization.nonce, Number(validAfter),
        Number(validBefore), now, oldIdx, genuineIdx(old.vendor_id)],
    );
    await storePair(c, ctx.cfg.sigEncKey!, id, newIdx, pair);
  });
  const tx = await sendQueued(db, ctx, { role: "payer", runId: id, idx: newIdx, action: "reissue", idempotencyKey: `${id}:reissue:${oldIdx}`, to: ctx.cfg.brake, data });
  if (tx.status !== "mined") throw new Error(`reissue reverted: ${tx.hash}`);
  const rh = (await ctx.pub.readContract({ address: ctx.cfg.brake, abi: brakeAbi, functionName: "requestHashOf", args: [run.run_id, BigInt(newIdx)] })) as Hex;
  const { evidenceHash } = await import("brake-signer");
  const evidence = { v: 1, kind: "FINANCE_REISSUE", runId: run.run_id, oldIdx, newIdx, newPayee: payee.toLowerCase(), amount: old.amount_units, phoneVerified: true };
  const hash = evidenceHash(evidence);
  await withTx(db, async (c) => {
    await lock(c, `run:${id}`);
    await c.query(`update lines set status = 'REISSUED' where run_id = $1 and idx = $2`, [id, oldIdx]);
    await c.query(`update lines set status = 'OPEN', request_hash = $3 where run_id = $1 and idx = $2`, [id, newIdx, rh]);
    await c.query(
      `update run_vendors set payee = $3, payee_changed_at = now(), payee_change_source = 'phone', payee_change_verified = 'phone',
         payee_change_verified_by = 'finance (re-issue)' where run_id = $1 and vendor_id = $2`,
      [id, old.vendor_id, payee],
    );
    await c.query(
      `insert into decisions (id, run_id, idx, verdict, rev, reason_code, model, evidence, evidence_hash, idempotency_key)
       values ($1,$2,$3,'FINANCE_ALLOW',0,'REISSUE_PHONE_VERIFIED','finance',$4,$5,$6) on conflict (idempotency_key) do nothing`,
      [newId("dec"), id, newIdx, evidence, hash, `${id}:${newIdx}:r0:FINANCE_ALLOW`],
    );
  });
  const allowTx = await payerAllow(db, ctx, id, newIdx, hash, `${id}:${newIdx}:r0:FINANCE_ALLOW`);
  return { newIdx, reused: false, reissueTx: tx.hash, allowTx };
}

function genuineIdx(vendorId: string): number | null {
  return vendorFixtures().find((v) => v.id === vendorId)?.genuineIdx ?? null;
}

export const evidenceUri = (ctx: ChainCtx, hash: Hex) =>
  process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/evidence/${hash}` : `brake:evidence/${hash}`;

export async function payerAllow(db: Db, ctx: ChainCtx, id: string, idx: number, hash: Hex, key: string): Promise<Hex> {
  const run = await getRun(db, id);
  const data = encodeFunctionData({ abi: brakeAbi, functionName: "allow", args: [run.run_id, [BigInt(idx)], [hash], [evidenceUri(ctx, hash)]] });
  const tx = await sendQueued(db, ctx, { role: "payer", runId: id, idx, action: "financeAllow", idempotencyKey: `tx:${key}`, to: ctx.cfg.brake, data });
  if (tx.status !== "mined") throw new Error(`payer allow reverted: ${tx.hash}`);
  await db.query(`update lines set status = 'ALLOWED' where run_id = $1 and idx = $2`, [id, idx]);
  await db.query(`update decisions set tx = $2, chain_status = 'ALLOWED' where idempotency_key = $1`, [key, tx.hash]);
  return tx.hash;
}

/** Finance decides a HELD/flagged line: payer `allow` (FINANCE_ALLOW) or `financeStop` (no budget, same receipt). */
export async function financeDecide(db: Db, ctx: ChainCtx, id: string, idx: number, action: "allow" | "stop", findingId?: string) {
  const run = await getRun(db, id);
  const line = (await getLines(db, id)).find((l) => l.idx === idx);
  if (!line) throw new HttpError(404, "line not found");
  if (TERMINAL.includes(line.status)) throw new HttpError(409, `line ${idx} is ${line.status}`);
  const { evidenceHash } = await import("brake-signer");
  const verdict = action === "allow" ? "FINANCE_ALLOW" : "FINANCE_STOP";
  const evidence = { v: 1, kind: verdict, runId: run.run_id, idx, rev: line.evidence_rev, finding: findingId ?? null };
  const hash = evidenceHash(evidence);
  const key = `${id}:${idx}:r${line.evidence_rev}:${verdict}`;
  await db.query(
    `insert into decisions (id, run_id, idx, verdict, rev, reason_code, model, evidence, evidence_hash, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,'finance',$7,$8,$9) on conflict (idempotency_key) do nothing`,
    [newId("dec"), id, idx, verdict, line.evidence_rev, action === "stop" ? "BANK_CHANGE_UNVERIFIED" : "FINANCE_REVIEWED", evidence, hash, key],
  );
  if (action === "allow") return { tx: await payerAllow(db, ctx, id, idx, hash, key) };
  const c = await loadSig(db, ctx.cfg.sigEncKey!, id, idx, "cancel");
  const { reasonToBytes32 } = await import("brake-signer");
  const data = encodeFunctionData({
    abi: brakeAbi,
    functionName: "financeStop",
    args: [run.run_id, BigInt(idx), reasonToBytes32("BANK_CHANGE_UNVERIFIED"), hash, evidenceUri(ctx, hash), c.sig.v, c.sig.r, c.sig.s],
  });
  const tx = await sendQueued(db, ctx, { role: "payer", runId: id, idx, action: "financeStop", idempotencyKey: `tx:${key}`, to: ctx.cfg.brake, data });
  if (tx.status !== "mined") throw new Error(`financeStop reverted: ${tx.hash}`);
  await db.query(`update lines set status = 'STOPPED', stop_tx = $3 where run_id = $1 and idx = $2`, [id, idx, tx.hash]);
  await db.query(`update decisions set tx = $2, chain_status = 'STOPPED' where idempotency_key = $1`, [key, tx.hash]);
  return { tx: tx.hash };
}

export async function revokeAgent(db: Db, ctx: ChainCtx, id: string) {
  const run = await getRun(db, id);
  const data = encodeFunctionData({ abi: brakeAbi, functionName: "revokeAgent", args: [run.run_id] });
  const tx = await sendQueued(db, ctx, { role: "payer", runId: id, action: "revokeAgent", idempotencyKey: `${id}:revoke`, to: ctx.cfg.brake, data });
  return { tx: tx.hash, status: tx.status };
}
