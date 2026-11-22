import {
  keccak256,
  TransactionNotFoundError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readTokenDomain, type TokenDomain } from "brake-signer";
import type { Config } from "./config.js";
import pg from "pg";
import { newId, type Db } from "./db.js";

export type Wallet = WalletClient<Transport, Chain, Account>;
export type Role = "payer" | "agent" | "keeper";

export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export interface ChainCtx {
  cfg: Config;
  chain: Chain;
  pub: PublicClient;
  wallets: Partial<Record<Role, Wallet>>;
  domain(): Promise<TokenDomain>;
  explorerTx(hash: Hex): string;
}

export function aevumChain(cfg: Config): Chain {
  return defineChain({
    id: cfg.chainId,
    name: "Aevum Testnet",
    nativeCurrency: { name: "QDAY", symbol: "QDAY", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: cfg.explorer } },
  });
}

export function makeChain(cfg: Config): ChainCtx {
  const chain = aevumChain(cfg);
  const transport = http(cfg.rpcUrl, { retryCount: 3, retryDelay: 300 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 500 }) as PublicClient;
  const wallets: Partial<Record<Role, Wallet>> = {};
  const keys: [Role, Hex | undefined][] = [
    ["payer", cfg.payerKey],
    ["agent", cfg.agentKey],
    ["keeper", cfg.keeperKey],
  ];
  for (const [role, key] of keys) {
    if (key) wallets[role] = createWalletClient({ account: privateKeyToAccount(key), chain, transport }) as Wallet;
  }
  let domain: Promise<TokenDomain> | undefined;
  return {
    cfg,
    chain,
    pub,
    wallets,
    domain: () => (domain ??= readTokenDomain(pub, cfg.token)),
    explorerTx: (h) => `${cfg.explorer}/tx/${h}`,
  };
}

export function wallet(ctx: ChainCtx, role: Role): Wallet {
  const w = ctx.wallets[role];
  if (!w) throw new Error(`no ${role} key configured`);
  return w;
}

export interface QueuedTx {
  id: string;
  hash: Hex;
  status: "sent" | "mined" | "reverted";
  reused: boolean;
}

/**
 * Send one tx through the per-EOA Postgres queue. Under a session advisory lock per sender: an existing row with the same
 * idempotency key is returned instead of sending again (retries never double-send), and the nonce is the max of the
 * chain's pending count and the queue's last used nonce + 1, so concurrent senders from stateless functions never
 * collide. `gas` is required for designed-to-revert txs (viem's estimateGas refuses them).
 */
export async function sendQueued(
  db: Db,
  ctx: ChainCtx,
  p: {
    role: Role;
    runId?: string | null;
    idx?: number | null;
    action: string;
    idempotencyKey: string;
    evidenceRev?: number | null;
    to: Address;
    data: Hex;
    gas?: bigint;
    /** a mined-reverted tx under the same key is re-sent unless the tx is designed to revert (proof-of-stop) */
    retryReverted?: boolean;
  },
): Promise<QueuedTx> {
  const w = wallet(ctx, p.role);
  const sender = w.account.address.toLowerCase();
  // the queue uses its own pool: callers often hold a connection in an outer transaction (run lock) while sending
  const qdb = queuePool(db);
  // one connection, session-level advisory lock, autocommit statements: the 'sent' row is durable before broadcast and
  // no second connection is ever needed while the lock is held (no pool deadlock)
  const sent = await withSessionLock(qdb, `sender:${sender}`, async (c) => {
    const prev = await c.query<{ id: string; tx_hash: Hex; status: string; sent_at: Date | null }>(
      `select id, tx_hash, status, coalesce(sent_at, created_at) as sent_at from tx_queue where idempotency_key = $1`,
      [p.idempotencyKey],
    );
    const row = prev.rows[0];
    const retry = row?.status === "reverted" && p.retryReverted !== false;
    if (row && row.tx_hash && row.status === "sent" && !retry) {
      const replaced = await replaceIfStuck(c, ctx, w, row);
      if (replaced) return replaced;
    }
    if (row && row.tx_hash && row.status !== "dropped" && !retry) {
      return { id: row.id, hash: row.tx_hash, status: row.status as QueuedTx["status"], reused: true };
    }
    const chainNonce = await ctx.pub.getTransactionCount({ address: w.account.address, blockTag: "pending" });
    const q = await c.query<{ n: string | null }>(
      `select max(nonce)::text as n from tx_queue where sender = $1 and status in ('sent','mined','reverted')`,
      [sender],
    );
    const queueNext = q.rows[0]?.n == null ? 0 : Number(q.rows[0].n) + 1;
    // the queue's nonce covers an RPC whose pending count lags; with nothing in flight, the chain is authoritative
    // (a dropped or reorged tx would otherwise leave a permanent nonce gap)
    const inflight = await c.query(`select 1 from tx_queue where sender = $1 and status = 'sent' limit 1`, [sender]);
    // a nonce recorded but never broadcast (crash between the 'sent' row and sendRawTransaction, later dropped) leaves a
    // hole that strands every higher nonce: refill the lowest such hole before allocating past it (a2a arch r03)
    const hole = await c.query<{ n: string | null }>(
      `select min(d.nonce)::text as n from tx_queue d
        where d.sender = $1 and d.status = 'dropped' and d.nonce >= $2
          and not exists (select 1 from tx_queue o where o.sender = $1 and o.nonce = d.nonce and o.status in ('sent','mined','reverted'))`,
      [sender, chainNonce],
    );
    const holeNonce = hole.rows[0]?.n == null ? null : Number(hole.rows[0].n);
    const nonce = holeNonce !== null && holeNonce < queueNext ? holeNonce : inflight.rowCount ? Math.max(chainNonce, queueNext) : chainNonce;
    const id = row?.id ?? newId("tx");
    const rowArgs = [id, sender, p.runId ?? null, p.idx ?? null, p.action, p.idempotencyKey, p.evidenceRev ?? null, nonce];
    const markDropped = (e: unknown) =>
      c.query(
        `insert into tx_queue (id, sender, run_id, idx, action, idempotency_key, evidence_rev, nonce, status, attempts, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'dropped',1,$9)
         on conflict (idempotency_key) do update set status='dropped', attempts=tx_queue.attempts+1, error=excluded.error`,
        [...rowArgs, String(e).slice(0, 500)],
      );
    let serialized: Hex;
    try {
      // Headroom over the estimate: Brake wraps the ERC-8004 receipt in try/catch, so the estimator's binary search can
      // settle on a limit where the receipt call runs out of gas and is caught (ReceiptFailed) — observed on the fork.
      const gas = p.gas ?? ((await ctx.pub.estimateGas({ account: w.account, to: p.to, data: p.data })) * 3n) / 2n + 50_000n;
      const req = await w.prepareTransactionRequest({ to: p.to, data: p.data, nonce, gas, chain: ctx.chain });
      serialized = await w.signTransaction(req as Parameters<Wallet["signTransaction"]>[0]);
    } catch (e) {
      await markDropped(e);
      throw e;
    }
    // record the hash BEFORE broadcasting (autocommit), so a crash or an ambiguous send error can never lose it
    const hash = keccak256(serialized);
    await c.query(
      `insert into tx_queue (id, sender, run_id, idx, action, idempotency_key, evidence_rev, nonce, tx_hash, status, attempts, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',1,now())
       on conflict (idempotency_key) do update set nonce=excluded.nonce, tx_hash=excluded.tx_hash, status='sent',
         attempts=tx_queue.attempts+1, error=null, sent_at=now()`,
      [...rowArgs, hash],
    );
    try {
      await ctx.pub.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      // drop the record only when the node positively says "not found"; an RPC error keeps it 'sent' (receipt decides)
      const notFound = await ctx.pub.getTransaction({ hash }).then(() => false, (x) => x instanceof TransactionNotFoundError);
      if (notFound) await markDropped(e);
      throw e;
    }
    return { id, hash, status: "sent" as const, reused: false };
  });
  if (sent.status !== "sent") return sent;
  // (a reused row still 'sent' is another caller's in-flight tx: wait for the same receipt instead of failing)
  let rc;
  try {
    rc = await ctx.pub.waitForTransactionReceipt({ hash: sent.hash, timeout: 120_000 });
  } catch (e) {
    // gone from the mempool (dropped, or reorged out): free the key so the next call rebuilds it at a fresh nonce
    const notFound = await ctx.pub.getTransaction({ hash: sent.hash }).then(() => false, (x) => x instanceof TransactionNotFoundError);
    // fenced on the hash this waiter checked: a row repointed at a pending replacement is not dropped (a2a arch r02)
    if (notFound)
      await qdb.query(`update tx_queue set status = 'dropped', error = $2 where id = $1 and tx_hash = $3 and status = 'sent'`, [sent.id, String(e).slice(0, 300), sent.hash]);
    throw e;
  }
  const status = rc.status === "success" ? "mined" : "reverted";
  // the receipt names the tx that actually mined (viem follows a same-nonce replacement either way)
  await qdb.query(`update tx_queue set status = $2, settled_at = now(), tx_hash = $3 where id = $1`, [sent.id, status, rc.transactionHash]);
  return { ...sent, hash: rc.transactionHash, status };
}

/** Seconds a broadcast may sit unmined before a retry re-sends it at the same nonce with higher fees. */
const STUCK_AFTER_S = Number(process.env.TX_STUCK_AFTER_S ?? 60);
const bump = (x: bigint | null | undefined, floor: bigint | null | undefined) => {
  const b = ((x ?? 0n) * 125n) / 100n + 1n; // +25%: above the usual 10% replacement threshold
  return floor != null && floor > b ? floor : b;
};

/**
 * Same-nonce replacement for a stuck tx (a2a arch r01): when a retry finds its row still 'sent' after STUCK_AFTER_S and
 * the node still holds the tx unmined, re-sign it with the same nonce, to, data and gas at +25% fees (or the current fee
 * estimate if higher), point the row at the new hash, and broadcast. If that broadcast fails (old tx mined meanwhile,
 * replacement refused), the row goes back to the old hash and the caller waits on it as before.
 */
async function replaceIfStuck(
  c: pg.PoolClient,
  ctx: ChainCtx,
  w: Wallet,
  row: { id: string; tx_hash: Hex; sent_at: Date | null },
): Promise<QueuedTx | null> {
  if (!row.sent_at || Date.now() - row.sent_at.getTime() < STUCK_AFTER_S * 1000) return null;
  if (await ctx.pub.getTransactionReceipt({ hash: row.tx_hash }).then(() => true, () => false)) return null;
  const old = await ctx.pub.getTransaction({ hash: row.tx_hash }).catch(() => null);
  if (!old || old.blockNumber != null || !old.to) return null; // unknown → the wait path drops it; mined → receipt soon
  const fees = await ctx.pub.estimateFeesPerGas().catch(() => null);
  const base = { account: w.account, chain: ctx.chain, to: old.to, data: old.input, nonce: old.nonce, gas: old.gas };
  const req =
    old.maxFeePerGas != null
      ? { ...base, type: "eip1559" as const, maxFeePerGas: bump(old.maxFeePerGas, fees?.maxFeePerGas), maxPriorityFeePerGas: bump(old.maxPriorityFeePerGas, fees?.maxPriorityFeePerGas) }
      : { ...base, type: "legacy" as const, gasPrice: bump(old.gasPrice, fees?.gasPrice) };
  const serialized = await w.signTransaction(req as Parameters<Wallet["signTransaction"]>[0]);
  const hash = keccak256(serialized);
  await c.query(`update tx_queue set tx_hash = $2, attempts = attempts + 1, sent_at = now(), error = $3 where id = $1`, [
    row.id,
    hash,
    `replaced ${row.tx_hash} (unmined ${STUCK_AFTER_S}s+, fees +25%)`,
  ]);
  try {
    await ctx.pub.sendRawTransaction({ serializedTransaction: serialized });
  } catch (e) {
    await c.query(`update tx_queue set tx_hash = $2, error = $3 where id = $1`, [row.id, row.tx_hash, `replacement refused: ${String(e).slice(0, 200)}`]);
    return null;
  }
  return { id: row.id, hash, status: "sent", reused: false };
}

async function withSessionLock<T>(pool: Db, key: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await fn(c);
    } finally {
      await c.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {
        broken = true; // a connection that may still hold the lock is destroyed, never pooled
      });
    }
  } finally {
    c.release(broken);
  }
}

const pools = new WeakMap<Db, Db>();
function queuePool(db: Db): Db {
  let q = pools.get(db);
  if (!q) {
    q = new pg.Pool({ connectionString: (db.options as { connectionString?: string }).connectionString, max: 3 });
    pools.set(db, q);
    const end = db.end.bind(db);
    db.end = (async () => {
      await q!.end();
      return end();
    }) as Db["end"];
  }
  return q;
}

/** Replay a mined tx's call at its parent block to read the revert reason (shown raw, labelled "replayed"). */
export async function replayRevert(ctx: ChainCtx, hash: Hex): Promise<string> {
  const tx = await ctx.pub.getTransaction({ hash });
  try {
    await ctx.pub.call({
      account: tx.from,
      to: tx.to!,
      data: tx.input,
      blockNumber: tx.blockNumber! - 1n,
      gas: tx.gas,
    });
    return "(replay did not revert)";
  } catch (e) {
    const m = /reverted with the following reason:\s*\n?(.*)/.exec(String((e as Error).message));
    return (m?.[1] ?? (e as { shortMessage?: string }).shortMessage ?? String(e)).trim();
  }
}
