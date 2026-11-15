import {
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
import { lock, newId, withTx, type Db } from "./db.js";

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
 * Send one tx through the per-EOA Postgres queue. Under `pg_advisory_xact_lock(sender)`: an existing row with the same
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
  },
): Promise<QueuedTx> {
  const w = wallet(ctx, p.role);
  const sender = w.account.address.toLowerCase();
  const sent = await withTx(db, async (c) => {
    await lock(c, `sender:${sender}`);
    const prev = await c.query<{ id: string; tx_hash: Hex; status: string }>(
      `select id, tx_hash, status from tx_queue where idempotency_key = $1`,
      [p.idempotencyKey],
    );
    const row = prev.rows[0];
    if (row && row.tx_hash && row.status !== "dropped") {
      return { id: row.id, hash: row.tx_hash, status: row.status as QueuedTx["status"], reused: true };
    }
    const chainNonce = await ctx.pub.getTransactionCount({ address: w.account.address, blockTag: "pending" });
    const q = await c.query<{ n: string | null }>(
      `select max(nonce)::text as n from tx_queue where sender = $1 and status in ('sent','mined','reverted')`,
      [sender],
    );
    const queueNext = q.rows[0]?.n == null ? 0 : Number(q.rows[0].n) + 1;
    const nonce = Math.max(chainNonce, queueNext);
    const id = row?.id ?? newId("tx");
    let hash: Hex;
    try {
      hash = await w.sendTransaction({ to: p.to, data: p.data, nonce, gas: p.gas, chain: ctx.chain });
    } catch (e) {
      await c.query(
        `insert into tx_queue (id, sender, run_id, idx, action, idempotency_key, evidence_rev, nonce, status, attempts, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'dropped',1,$9)
         on conflict (idempotency_key) do update set status='dropped', attempts=tx_queue.attempts+1, error=excluded.error`,
        [id, sender, p.runId ?? null, p.idx ?? null, p.action, p.idempotencyKey, p.evidenceRev ?? null, nonce, String(e).slice(0, 500)],
      );
      throw e;
    }
    await c.query(
      `insert into tx_queue (id, sender, run_id, idx, action, idempotency_key, evidence_rev, nonce, tx_hash, status, attempts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',1)
       on conflict (idempotency_key) do update set nonce=excluded.nonce, tx_hash=excluded.tx_hash, status='sent',
         attempts=tx_queue.attempts+1, error=null`,
      [id, sender, p.runId ?? null, p.idx ?? null, p.action, p.idempotencyKey, p.evidenceRev ?? null, nonce, hash],
    );
    return { id, hash, status: "sent" as const, reused: false };
  });
  if (sent.status !== "sent") return sent;
  const rc = await ctx.pub.waitForTransactionReceipt({ hash: sent.hash, timeout: 120_000 });
  const status = rc.status === "success" ? "mined" : "reverted";
  await db.query(`update tx_queue set status = $2 where id = $1`, [sent.id, status]);
  return { ...sent, status };
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
