import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { eip3009Abi, lineStatus, randomNonce, signTransferAuthorization } from "brake-signer";
import { multicall3Abi, replayRevert, sendQueued, wallet, type ChainCtx } from "./chain.js";
import { lock, withTx, type Db } from "./db.js";
import { sendHold } from "./executor.js";
import { chainNow, enqueueReview, getLines, getRun, loadSig, syncStatus, TERMINAL, type LineRow } from "./runs.js";

export interface PaydayResult {
  notYet: { idx: number; validAfter: number; secondsLeft: number }[];
  simulation: { idx: number; success: boolean }[];
  batchTx?: Hex;
  paid: { idx: number; tx: Hex }[];
  proofs: { idx: number; tx: Hex; replayed: string }[];
  held: { idx: number; reason: string; tx?: Hex }[];
  skipped: { idx: number; why: string }[];
}

const twaData = (s: Awaited<ReturnType<typeof loadSig>>) =>
  encodeFunctionData({
    abi: eip3009Abi,
    functionName: "transferWithAuthorization",
    args: [s.authorization.from, s.authorization.to, s.authorization.value, s.authorization.validAfter, s.authorization.validBefore, s.authorization.nonce, s.sig.v, s.sig.r, s.sig.s],
  });

/**
 * Payday for one run. Idempotent and re-callable: each call picks up lines that became payable since the last one.
 * - ALLOWED with a fresh decision (its revision = the line's revision) → paid in ONE Multicall3 aggregate3 batch, after a
 *   pre-send eth_call simulation (per-call outcomes are not in a mined aggregate3 receipt, so what actually paid is read
 *   back from tUSD8 AuthorizationUsed logs).
 * - ALLOWED but stale, or never reviewed (OPEN) → HELD (REVIEW_STALE), fail-closed, and a re-review is queued.
 * - STOPPED → proof-of-stop: the cancelled payment is submitted on its own with explicit gas and reverts on-chain;
 *   its reason is read by replaying the call at the parent block.
 */
export async function payday(db: Db, ctx: ChainCtx, id: string): Promise<PaydayResult> {
  const run = await getRun(db, id);
  const key = ctx.cfg.sigEncKey!;
  const res: PaydayResult = { notYet: [], simulation: [], paid: [], proofs: [], held: [], skipped: [] };
  const now = await chainNow(ctx);
  const lines = await getLines(db, id);
  const payable: { line: LineRow; data: Hex }[] = [];

  for (const l of lines) {
    if (l.status === "PAID" || l.status === "SIGNED") continue;
    const on = (await lineStatus(ctx.pub, ctx.cfg.brake, run.run_id, l.idx)).status;
    if ((on === "OPEN" || on === "ALLOWED" || on === "HELD") && l.status !== on && !TERMINAL.includes(l.status)) {
      l.status = (await syncStatus(db, ctx, id, run.run_id, l.idx)) as string;
    }
    const va = Math.floor(l.valid_after.getTime() / 1000);
    const open = now > BigInt(va);
    // the proof-of-stop runs inside the payment window, so its revert is "used or canceled", not "not yet valid"
    if (on === "STOPPED") {
      // only inside [validAfter, validBefore): after validBefore the token reverts for expiry, which proves nothing
      const inWindow = open && now < BigInt(Math.floor(l.valid_before.getTime() / 1000));
      if (!l.proof_tx && inWindow) res.proofs.push(await proofOfStop(db, ctx, id, l));
      continue;
    }
    if (TERMINAL.includes(l.status) || on === "CONSUMED" || on === "REISSUED") continue;
    if (!open) {
      res.notYet.push({ idx: l.idx, validAfter: va, secondsLeft: va - Number(now) + 1 });
      continue;
    }
    if (on === "HELD") {
      res.held.push({ idx: l.idx, reason: "HELD on-chain (finance decides)" });
      continue;
    }
    const last = await db.query<{ rev: number; verdict: string }>(
      `select rev, verdict from decisions where run_id = $1 and idx = $2 order by created_at desc limit 1`,
      [id, l.idx],
    );
    const d = last.rows[0];
    const fresh = on === "ALLOWED" && d && (d.verdict === "ALLOW" || d.verdict === "FINANCE_ALLOW") && d.rev === l.evidence_rev;
    if (!fresh) {
      const why = on === "OPEN" ? "never reviewed" : `decision rev ${d?.rev} ≠ line rev ${l.evidence_rev}`;
      // never paid either way; a failing hold (revoked grant, expired agent) must not block the other lines' payday.
      // The hold is a queued action too: under the run lock, re-read revision, latest decision and Brake status first,
      // so a finance allow that landed since the scan is not turned back into HELD (a2a arch r01)
      try {
        const h = await withTx(db, async (c) => {
          await lock(c, `run:${id}`);
          const cur = (await c.query<{ evidence_rev: number }>(`select evidence_rev from lines where run_id = $1 and idx = $2`, [id, l.idx])).rows[0]!;
          const d2 = (await c.query<{ rev: number; verdict: string }>(`select rev, verdict from decisions where run_id = $1 and idx = $2 order by created_at desc limit 1`, [id, l.idx])).rows[0];
          const on2 = (await lineStatus(ctx.pub, ctx.cfg.brake, run.run_id, l.idx)).status;
          if (on2 === "ALLOWED" && d2 && (d2.verdict === "ALLOW" || d2.verdict === "FINANCE_ALLOW") && d2.rev === cur.evidence_rev) return "fresh" as const;
          if (on2 !== "OPEN" && on2 !== "ALLOWED") return "moved" as const;
          return sendHold(db, ctx, id, run.run_id, l.idx, "REVIEW_STALE", ("0x" + "0".repeat(64)) as Hex, `${id}:${l.idx}:r${cur.evidence_rev}:STALE`);
        });
        if (h === "fresh") {
          // decided since the scan: it joins the batch, where the broadcast re-check runs again under the lock
          payable.push({ line: l, data: twaData(await loadSig(db, key, id, l.idx, "payment")) });
          continue;
        }
        if (h === "moved") {
          res.skipped.push({ idx: l.idx, why: "changed since the scan (held, stopped or consumed) — not paid, not re-held" });
          continue;
        }
        // a reverted hold (revoked grant, expired agent) is reported as such: the line is still not paid (a2a arch r02)
        res.held.push(
          h.chainStatus === "HELD"
            ? { idx: l.idx, reason: `REVIEW_STALE (${why})`, tx: h.tx }
            : { idx: l.idx, reason: `not paid: REVIEW_STALE (${why}); on-chain hold ${h.chainStatus ?? "failed"}`, tx: h.tx },
        );
      } catch (e) {
        res.held.push({ idx: l.idx, reason: `not paid: REVIEW_STALE (${why}); on-chain hold failed: ${String((e as Error).message).slice(0, 120)}` });
      }
      await enqueueReview(db, id, "stale");
      continue;
    }
    payable.push({ line: l, data: twaData(await loadSig(db, key, id, l.idx, "payment")) });
  }

  if (payable.length) {
    // freshness at broadcast: under the per-run lock (the one inbox linking, holds and finance decisions take) re-read each
    // line's revision, latest decision and Brake status; anything that changed since the scan above is dropped, not paid
    const tx = await withTx(db, async (c) => {
      await lock(c, `run:${id}`);
      const still: typeof payable = [];
      for (const p of payable) {
        const cur = (await c.query<{ evidence_rev: number; status: string }>(`select evidence_rev, status from lines where run_id = $1 and idx = $2`, [id, p.line.idx])).rows[0]!;
        const d = (await c.query<{ rev: number; verdict: string }>(`select rev, verdict from decisions where run_id = $1 and idx = $2 order by created_at desc limit 1`, [id, p.line.idx])).rows[0];
        const on = (await lineStatus(ctx.pub, ctx.cfg.brake, run.run_id, p.line.idx)).status;
        const ok = on === "ALLOWED" && cur.status === "ALLOWED" && d && (d.verdict === "ALLOW" || d.verdict === "FINANCE_ALLOW") && d.rev === cur.evidence_rev;
        // nonce already used on-chain — an earlier batch whose PAID update was lost, or a cancel outside Brake.
        // authorizationState cannot tell which, so never re-send and never write PAID here: the reconciler classifies it
        // from tUSD8 AuthorizationUsed / AuthorizationCanceled logs (I8; a2a arch r01)
        const used = ok && ((await ctx.pub.readContract({ address: ctx.cfg.token, abi: eip3009Abi, functionName: "authorizationState", args: [run.payer, p.line.nonce] })) as boolean);
        if (used) {
          res.skipped.push({ idx: p.line.idx, why: "nonce already used on-chain (paid or cancelled) — not re-sent; the reconciler classifies it from tUSD8 logs" });
        } else if (ok) still.push(p);
        else res.skipped.push({ idx: p.line.idx, why: "changed at broadcast (new evidence, hold or finance decision) — not paid, re-review queued" });
      }
      payable.length = 0;
      payable.push(...still);
      if (!payable.length) return null;
      const calls = payable.map((p) => ({ target: ctx.cfg.token, allowFailure: true, callData: p.data }));
      const sim = await ctx.pub.simulateContract({ address: ctx.cfg.multicall3, abi: multicall3Abi, functionName: "aggregate3", args: [calls], account: wallet(ctx, "keeper").account });
      res.simulation = sim.result.map((r, i) => ({ idx: payable[i]!.line.idx, success: r.success }));
      return sendQueued(db, ctx, {
        role: "keeper",
        runId: id,
        action: "payday",
        idempotencyKey: await paydayKey(c, `${id}:payday:${payable.map((p) => p.line.idx).join(",")}`),
        to: ctx.cfg.multicall3,
        data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
        gas: 150_000n + 120_000n * BigInt(calls.length),
      });
    });
    if (res.skipped.length) await enqueueReview(db, id, "stale");
    if (!tx) return res;
    res.batchTx = tx.hash;
    const rc = await ctx.pub.getTransactionReceipt({ hash: tx.hash });
    const used = parseEventLogs({ abi: eip3009Abi, eventName: "AuthorizationUsed", logs: rc.logs });
    const usedNonces = new Set(used.map((u) => (u.args as { nonce: Hex }).nonce.toLowerCase()));
    for (const p of payable) {
      if (usedNonces.has(p.line.nonce.toLowerCase())) {
        await db.query(`update lines set status = 'PAID', paid_tx = $3 where run_id = $1 and idx = $2`, [id, p.line.idx, tx.hash]);
        res.paid.push({ idx: p.line.idx, tx: tx.hash });
      } else res.skipped.push({ idx: p.line.idx, why: "call failed inside the batch (no AuthorizationUsed)" });
    }
  }
  return res;
}

/**
 * Payday key: reuse an in-flight batch for the same lines; otherwise a new attempt suffix. The lines passed the re-check
 * (still ALLOWED, not PAID), so any earlier mined batch for this exact set paid none of them (all calls failed inside
 * Multicall3) and must not block a retry.
 */
async function paydayKey(c: { query: Db["query"] }, base: string): Promise<string> {
  const prev = await c.query<{ idempotency_key: string; status: string }>(
    `select idempotency_key, status from tx_queue where idempotency_key = $1 or idempotency_key like $1 || ':a%'`,
    [base],
  );
  const inflight = prev.rows.find((r) => r.status === "sent");
  if (inflight) return inflight.idempotency_key;
  return prev.rows.length ? `${base}:a${prev.rows.length}` : base;
}

async function proofOfStop(db: Db, ctx: ChainCtx, id: string, l: LineRow) {
  const s = await loadSig(db, ctx.cfg.sigEncKey!, id, l.idx, "payment");
  const tx = await sendQueued(db, ctx, {
    role: "keeper",
    runId: id,
    idx: l.idx,
    action: "proofOfStop",
    idempotencyKey: `${id}:${l.idx}:proofOfStop`,
    to: ctx.cfg.token,
    data: twaData(s),
    gas: 120_000n,
    retryReverted: false, // designed to revert
  });
  const replayed = tx.status === "reverted" ? await replayRevert(ctx, tx.hash) : "(did not revert — investigate)";
  await db.query(`update lines set proof_tx = $3, proof_reason = $4 where run_id = $1 and idx = $2`, [id, l.idx, tx.hash, replayed]);
  if (tx.status !== "reverted") {
    // a stopped line's payment executed: this must never happen (I3) — page finance with a recovery ticket
    await db.query(
      `insert into tickets (id, kind, run_id, idx, body) select $1, 'recovery', $2, $3, $4
        where not exists (select 1 from tickets where kind = 'recovery' and run_id = $2 and idx = $3)`,
      [`tkt_${tx.hash.slice(2, 18)}_${l.idx}`, id, l.idx, `PROOF-OF-STOP DID NOT REVERT: line ${l.idx + 1} was paid in ${tx.hash} after its stop — recover from the payee and investigate`],
    );
  }
  return { idx: l.idx, tx: tx.hash, replayed };
}

// ----------------------------------------------------------------------------------------------------- sweep

/** Seeded payee key for a mnemonic index (demo only: payee wallets are swept back to the payer after each run). */
function payeeAccount(mnemonic: string, idx: number) {
  return mnemonicToAccount(mnemonic, { addressIndex: idx });
}

/**
 * After every line is terminal: each paid payee signs an EIP-3009 transfer back to the payer and the keeper submits them
 * in one Multicall3 batch (payees need no gas). Releases the run's liquidity reservation.
 */
export async function sweep(db: Db, ctx: ChainCtx, id: string) {
  const run = await getRun(db, id);
  if (run.sweep_tx) return { tx: run.sweep_tx as Hex, reused: true, swept: 0 };
  const lines = await getLines(db, id);
  if (lines.some((l) => !TERMINAL.includes(l.status))) return { tx: null, reused: false, swept: 0, pending: true };
  const mnemonic = ctx.cfg.payeesMnemonic!;
  const domain = await ctx.domain();
  const now = await chainNow(ctx);
  const totals = new Map<number, bigint>();
  for (const l of lines.filter((x) => (x.status === "PAID" || x.status === "TOO_LATE") && x.payee_idx !== null)) {
    totals.set(l.payee_idx!, (totals.get(l.payee_idx!) ?? 0n) + BigInt(l.amount_units));
  }
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  for (const [idx, amount] of totals) {
    const acct = payeeAccount(mnemonic, idx);
    const bal = (await ctx.pub.readContract({ address: ctx.cfg.token, abi: eip3009Abi, functionName: "balanceOf", args: [acct.address] })) as bigint;
    const value = bal < amount ? bal : amount;
    if (value === 0n) continue;
    const a = { from: acct.address, to: run.payer, value, validAfter: 0n, validBefore: now + 3600n, nonce: randomNonce() };
    const sig = await signTransferAuthorization(acct, domain, a);
    calls.push({ target: ctx.cfg.token, allowFailure: true, callData: twaData({ authorization: a, sig }) });
  }
  if (!calls.length) {
    await db.query(`update runs set settled_at = now(), reserved_units = 0 where id = $1`, [id]);
    return { tx: null, reused: false, swept: 0 };
  }
  const tx = await sendQueued(db, ctx, {
    role: "keeper",
    runId: id,
    action: "sweep",
    idempotencyKey: `${id}:sweep`,
    to: ctx.cfg.multicall3,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
    gas: 150_000n + 120_000n * BigInt(calls.length),
  });
  // settle only on what the token actually moved: a reverted batch, or one whose inner transfers all failed, is not
  // recorded, so the next sweep retries (a2a arch r01)
  if (tx.status !== "mined") throw new Error(`sweep ${tx.hash} ${tx.status} — not settled, retry`);
  const rc = await ctx.pub.getTransactionReceipt({ hash: tx.hash });
  const moved = parseEventLogs({ abi: eip3009Abi, eventName: "AuthorizationUsed", logs: rc.logs }).length;
  if (moved < calls.length) {
    // some legs failed: free the key so the next sweep rebuilds from current balances (paid-back payees read 0 and drop
    // out). After 3 sends the run settles anyway with a ticket naming the stranded amount (a2a arch r02).
    const sends = (await db.query<{ attempts: number }>(`select attempts from tx_queue where id = $1`, [tx.id])).rows[0]?.attempts ?? 1;
    if (sends < 3) {
      await db.query(`update tx_queue set status = 'dropped', error = $2 where id = $1`, [tx.id, `sweep moved ${moved}/${calls.length} legs`]);
      throw new Error(`sweep ${tx.hash}: moved ${moved}/${calls.length} legs — not settled, retry`);
    }
    await db.query(
      `insert into tickets (id, kind, run_id, body) values ($1, 'recovery', $2, $3) on conflict (id) do nothing`,
      [`tkt:sweep:${id}`, id, `sweep left ${calls.length - moved} payee leg(s) unrecovered after ${sends} sends (last ${tx.hash}) — recover by hand`],
    );
  }
  await db.query(`update runs set sweep_tx = $2, settled_at = now(), reserved_units = 0 where id = $1`, [id, tx.hash]);
  return { tx: tx.hash, reused: false, swept: moved, attempted: calls.length };
}

/**
 * Settle runs that can no longer change: past every line's validBefore (+10 min grace) → open lines EXPIRED; never opened
 * on-chain 30 min after creation → EXPIRED. Either way the liquidity reservation is released so admission never locks up.
 */
export async function expireRuns(db: Db): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select r.id from runs r
      where r.settled_at is null and (
        (r.open_tx is null and r.created_at < now() - interval '30 minutes') or
        not exists (select 1 from lines l where l.run_id = r.id and l.valid_before > now() - interval '10 minutes'))`,
  );
  const ids = r.rows.map((x) => x.id);
  if (ids.length) {
    await db.query(
      `update lines set status = 'EXPIRED' where run_id = any($1) and status in ('SIGNED','OPEN','ALLOWED','HELD')`,
      [ids],
    );
  }
  return ids;
}

/** Expire, then sweep: paid lines of an expired run go back to the payer before its reservation is released. */
export async function settleExpired(db: Db, ctx: ChainCtx): Promise<string[]> {
  const ids = await expireRuns(db);
  for (const id of ids) {
    try {
      await sweep(db, ctx, id);
    } catch {
      /* retried on the next tick: the run stays unsettled */
    }
  }
  return ids;
}

/** Cron backstop: every run whose payment window opened 10+ minutes ago (grace so an interactive visitor is never paid out from under
 * their walk) and is not settled gets a payday; finished runs get swept. */
export async function dueRuns(db: Db): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select distinct r.id from runs r join lines l on l.run_id = r.id
      where r.settled_at is null and r.open_tx is not null and l.valid_after <= now() - interval '10 minutes' and l.valid_before > now()
      order by r.id limit 20`,
  );
  return r.rows.map((x) => x.id);
}

