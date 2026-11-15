import { encodeFunctionData, parseEventLogs, type Hex, type Log } from "viem";
import { brakeAbi, eip3009Abi, lineStatus } from "brake-signer";
import { sendQueued, type ChainCtx } from "./chain.js";
import { lock, withTx, type Db } from "./db.js";

const CHUNK = 5_000n;
const usedEvent = eip3009Abi.find((x) => x.type === "event" && x.name === "AuthorizationUsed")!;
const canceledEvent = eip3009Abi.find((x) => x.type === "event" && x.name === "AuthorizationCanceled")!;

export interface ReconcileResult {
  from: bigint;
  to: bigint;
  head: bigint;
  events: number;
  updates: { runId: string; idx: number; status: string; tx: Hex }[];
  retried: { runId: string; idx: number; tx: Hex }[];
}

const cursorName = (ctx: ChainCtx) => `reconciler:${ctx.cfg.brake.toLowerCase()}`;

/**
 * Scan Brake + tUSD8 (authorizer = our payers) logs into chain_events, then derive line statuses:
 * - AuthorizationUsed on a line's nonce → PAID; if Brake also recorded StopConsumed for it → TOO_LATE (I8).
 * - AuthorizationCanceled with a LineStopped in the same tx → STOPPED; without one → EXTERNALLY_CANCELLED (I8).
 * - ReceiptFailed with the line's receipt still pending → retryReceipt (I9).
 * Reorg-safe: every pass deletes and re-scans the last CONFIRMATIONS blocks below the cursor; a line whose paid_tx /
 * stop_tx pointed at a token event that vanished in that rescan is rolled back to its Brake status (a2a arch r01).
 * Token events are matched to lines by (authorizer = run payer, nonce), never by nonce alone.
 */
export async function reconcile(db: Db, ctx: ChainCtx, opts: { fromBlock?: bigint } = {}): Promise<ReconcileResult> {
  const conf = BigInt(ctx.cfg.confirmations);
  return withTx(db, async (c) => {
    await lock(c, "reconciler");
    const head = await ctx.pub.getBlockNumber();
    const cur = await c.query<{ last_block: string }>(`select last_block from cursors where name = $1`, [cursorName(ctx)]);
    const deployBlock = BigInt(process.env.DEPLOY_BLOCK ?? (await firstRunBlock(ctx, c)) ?? head - 1000n);
    let from = opts.fromBlock ?? (cur.rows[0] ? BigInt(cur.rows[0].last_block) - conf : deployBlock);
    if (from < 0n) from = 0n;
    // token-event txs inside the rescan window before it is cleared: any that do not come back were reorged out
    const before = (
      await c.query<{ tx_hash: string }>(
        `select distinct tx_hash from chain_events where block_number >= $1 and name in ('AuthorizationUsed','AuthorizationCanceled')`,
        [from.toString()],
      )
    ).rows.map((r) => r.tx_hash.toLowerCase());
    await c.query(`delete from chain_events where block_number >= $1`, [from.toString()]);
    const payers = (await c.query<{ payer: Hex }>(`select distinct payer from runs`)).rows.map((r) => r.payer);
    let events = 0;
    const logs: Log[] = [];
    for (let a = from; a <= head; a += CHUNK) {
      const b = a + CHUNK - 1n > head ? head : a + CHUNK - 1n;
      logs.push(...(await ctx.pub.getLogs({ address: ctx.cfg.brake, fromBlock: a, toBlock: b })));
      if (payers.length) {
        logs.push(...(await ctx.pub.getLogs({ address: ctx.cfg.token, event: usedEvent, args: { authorizer: payers }, fromBlock: a, toBlock: b })));
        logs.push(...(await ctx.pub.getLogs({ address: ctx.cfg.token, event: canceledEvent, args: { authorizer: payers }, fromBlock: a, toBlock: b })));
      }
    }
    const brakeLogs = parseEventLogs({ abi: brakeAbi, logs: logs.filter((l) => l.address.toLowerCase() === ctx.cfg.brake.toLowerCase()) });
    const tokenLogs = parseEventLogs({ abi: eip3009Abi, logs: logs.filter((l) => l.address.toLowerCase() === ctx.cfg.token.toLowerCase()) });
    const runIdMap = new Map(
      (await c.query<{ id: string; run_id: string }>(`select id, run_id from runs`)).rows.map((r) => [r.run_id.toLowerCase(), r.id]),
    );
    const jsonArgs = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const l of brakeLogs) {
      const args = l.args as Record<string, unknown>;
      const rid = typeof args.runId === "string" ? runIdMap.get(args.runId.toLowerCase()) ?? null : null;
      const idx = args.idx !== undefined ? Number(args.idx) : null;
      await c.query(
        `insert into chain_events (tx_hash, log_index, block_number, address, name, run_id, idx, args) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict do nothing`,
        [l.transactionHash, l.logIndex, l.blockNumber!.toString(), l.address, l.eventName, rid, idx, jsonArgs(args)],
      );
      events++;
    }
    for (const l of tokenLogs) {
      const { nonce, authorizer } = l.args as { nonce?: Hex; authorizer?: Hex };
      // a nonce is unique per payer only (EIP-3009 and Brake's nonceRegistered are both keyed by payer)
      const line =
        nonce && authorizer
          ? (
              await c.query<{ run_id: string; idx: number }>(
                `select l.run_id, l.idx from lines l join runs r on r.id = l.run_id where lower(l.nonce) = lower($1) and lower(r.payer) = lower($2)`,
                [nonce, authorizer],
              )
            ).rows[0]
          : undefined;
      await c.query(
        `insert into chain_events (tx_hash, log_index, block_number, address, name, run_id, idx, args) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict do nothing`,
        [l.transactionHash, l.logIndex, l.blockNumber!.toString(), l.address, l.eventName, line?.run_id ?? null, line?.idx ?? null, jsonArgs(l.args)],
      );
      events++;
    }

    const updates: ReconcileResult["updates"] = [];
    // roll back projections built on token events that a reorg removed: back to what Brake says now, tx pointer cleared
    const present = new Set(tokenLogs.map((l) => l.transactionHash!.toLowerCase()));
    for (const h of before.filter((x) => !present.has(x))) {
      const hit = await c.query<{ run_id: string; idx: number; chain_run: Hex }>(
        `select l.run_id, l.idx, r.run_id as chain_run from lines l join runs r on r.id = l.run_id
          where lower(l.paid_tx) = $1 or lower(l.stop_tx) = $1`,
        [h],
      );
      for (const r of hit.rows) {
        const st = (await lineStatus(ctx.pub, ctx.cfg.brake, r.chain_run, r.idx)).status;
        await c.query(
          `update lines set status = $3,
             paid_tx = case when lower(paid_tx) = $4 then null else paid_tx end,
             stop_tx = case when lower(stop_tx) = $4 then null else stop_tx end
           where run_id = $1 and idx = $2`,
          [r.run_id, r.idx, st, h],
        );
        updates.push({ runId: r.run_id, idx: r.idx, status: st, tx: h as Hex });
      }
    }

    // derive statuses from everything we hold (not just this window), so a restart converges
    const rows = await c.query<{ run_id: string; idx: number; name: string; tx_hash: Hex; status: string }>(
      `select e.run_id, e.idx, e.name, e.tx_hash, l.status from chain_events e
         join lines l on l.run_id = e.run_id and l.idx = e.idx
        where e.name in ('AuthorizationUsed','AuthorizationCanceled') order by e.block_number, e.log_index`,
    );
    for (const r of rows.rows) {
      let next: string | null = null;
      if (r.name === "AuthorizationUsed") {
        const consumed = await c.query(`select 1 from chain_events where run_id = $1 and idx = $2 and name = 'StopConsumed'`, [r.run_id, r.idx]);
        next = consumed.rowCount ? "TOO_LATE" : "PAID";
        if (r.status !== next) await c.query(`update lines set status = $3, paid_tx = coalesce(paid_tx, $4) where run_id = $1 and idx = $2`, [r.run_id, r.idx, next, r.tx_hash]);
        if (next === "TOO_LATE" && r.status !== next) {
          await c.query(
            `insert into tickets (id, kind, run_id, idx, body) select $1, 'recovery', $2, $3, $4
              where not exists (select 1 from tickets where kind = 'recovery' and run_id = $2 and idx = $3)`,
            [`tkt_${r.tx_hash.slice(2, 18)}_${r.idx}`, r.run_id, r.idx, `TOO LATE: line ${r.idx + 1} was already paid in ${r.tx_hash} before the stop — recover from the payee`],
          );
        }
      } else {
        const viaBrake = await c.query(`select 1 from chain_events where tx_hash = $1 and name = 'LineStopped'`, [r.tx_hash]);
        next = viaBrake.rowCount ? "STOPPED" : "EXTERNALLY_CANCELLED";
        if (next === "STOPPED" && r.status === "REISSUED") next = null; // a re-issued line stays REISSUED
        if (next && r.status !== next) await c.query(`update lines set status = $3, stop_tx = coalesce(stop_tx, $4) where run_id = $1 and idx = $2`, [r.run_id, r.idx, next, r.tx_hash]);
      }
      if (next && r.status !== next) updates.push({ runId: r.run_id, idx: r.idx, status: next, tx: r.tx_hash });
    }
    await c.query(
      `insert into cursors (name, last_block) values ($1, $2) on conflict (name) do update set last_block = excluded.last_block`,
      [cursorName(ctx), head.toString()],
    );

    // receipts that failed and are still pending → retryReceipt (anyone may call; the validator stays Brake)
    const retried: ReconcileResult["retried"] = [];
    const failed = await c.query<{ run_id: string; idx: number; chain_run: Hex }>(
      `select distinct e.run_id, e.idx, r.run_id as chain_run from chain_events e join runs r on r.id = e.run_id
        where e.name = 'ReceiptFailed' and lower(e.address) = lower($1)`,
      [ctx.cfg.brake],
    );
    for (const f of failed.rows) {
      // only this deployment's lines, and one unreadable line never aborts the pass (found while verifying a2a arch r01)
      const st = (await ctx.pub
        .readContract({ address: ctx.cfg.brake, abi: brakeAbi, functionName: "lineDetail", args: [f.chain_run, BigInt(f.idx)] })
        .catch(() => null)) as { receiptPending: boolean } | null;
      if (!st?.receiptPending || !ctx.wallets.keeper) continue;
      try {
        const tx = await sendQueued(db, ctx, {
          role: "keeper",
          runId: f.run_id,
          idx: f.idx,
          action: "retryReceipt",
          // one retry per line per 10 minutes: a registry that stays down must not cost a keeper tx on every pass
          idempotencyKey: `${f.run_id}:${f.idx}:retryReceipt:${Math.floor(Date.now() / 600_000)}`,
          to: ctx.cfg.brake,
          data: encodeFunctionData({ abi: brakeAbi, functionName: "retryReceipt", args: [f.chain_run, BigInt(f.idx)] }),
          gas: 400_000n,
        });
        retried.push({ runId: f.run_id, idx: f.idx, tx: tx.hash });
      } catch {
        /* registry still failing — try again next tick */
      }
    }
    return { from, to: head, head, events, updates, retried };
  });
}

async function firstRunBlock(ctx: ChainCtx, c: { query: Db["query"] }): Promise<bigint | null> {
  const r = await c.query<{ open_tx: Hex }>(`select open_tx from runs where open_tx is not null order by created_at limit 1`);
  if (!r.rows[0]) return null;
  // an open tx this chain does not know (DB rows from another deployment, a reset fork, a reorged openRun) must not
  // crash the reconciler: fall back to the caller's default window (found while verifying a2a arch r01)
  const rc = await ctx.pub.getTransactionReceipt({ hash: r.rows[0].open_tx }).catch(() => null);
  return rc ? rc.blockNumber : null;
}

/** Block depth at which an event counts as final (CONFIRMATIONS, default 3 — Aevum finality depth is undocumented). */
export function isFinal(block: bigint, head: bigint, confirmations: number) {
  return head - block >= BigInt(confirmations);
}
