// pnpm sign:local — ONE non-custodial run. The payer key stays in this process: it signs every payment authorization and its
// paired cancel, and it sends openRun itself. The server (BASE_URL) only receives signatures — it verifies each one recovers to
// the payer — plus the openRun tx hash. It then reviews, stops line 3 on E4, and the keeper pays the rest with the signatures.
//
// Honesty note: Brake.openRun requires the payer to own the agent's ERC-8004 identity, and the demo agent identity is owned by
// the demo payer, so this script signs with that same key (read locally from ~/.config/brake, never sent anywhere). A production
// payer registers its own agent identity (README roadmap). What this proves is the PATH: the server accepts only signed data.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openRun, readTokenDomain, signRun } from "brake-signer";
import { loadLocalEnv } from "./env.js";
import { loadConfig, REPO_ROOT } from "@brake/engine/config";
import { aevumChain } from "@brake/engine/chain";

loadLocalEnv();
const base = process.env.BASE_URL ?? "http://localhost:3000";
const cfg = loadConfig();
const key = (process.env.SIGN_LOCAL_PRIVATE_KEY ?? process.env.DEMO_PAYER_PRIVATE_KEY) as Hex | undefined;
if (!key) throw new Error("set SIGN_LOCAL_PRIVATE_KEY (or have DEMO_PAYER_PRIVATE_KEY in ~/.config/brake/wallets.env)");
const account = privateKeyToAccount(key);
const chain = aevumChain(cfg);
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
const t0 = Date.now();
const steps: Record<string, unknown>[] = [];
const log = (step: string, data: Record<string, unknown> = {}) => {
  steps.push({ step, sinceStartMs: Date.now() - t0, ...data });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`, JSON.stringify(data));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const r = await fetch(base + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`);
  return j;
}

const plan = await api<{ validAfter: string; validBefore: string; agentId: string; agent: string; maxStops: number; alarmAt: number; lines: { to: Hex; value: string }[] }>("/api/plan?scenario=hero");
log("plan fetched", { lines: plan.lines.length });
const validAfter = BigInt(plan.validAfter);
const validBefore = BigInt(plan.validBefore);
const pairs = await signRun(account, await readTokenDomain(pub, cfg.token), { validAfter, validBefore, lines: plan.lines.map((l) => ({ to: l.to, value: BigInt(l.value) })) });
log("signed locally (payment + paired cancel per line)", { payer: account.address, lines: pairs.length });
const runId = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
const created = await api<{ id: string; token: string }>("/api/runs", {
  body: {
    mode: "wallet", scenario: "hero", payer: account.address, runId, validAfter: plan.validAfter, validBefore: plan.validBefore,
    pairs: pairs.map((p) => ({ to: p.authorization.to, value: p.authorization.value.toString(), nonce: p.authorization.nonce, payment: p.payment.signature, cancel: p.cancel.signature })),
  },
});
log("server accepted signed authorizations (it never saw the key)", { run: created.id });
const openTx = await openRun(wallet, cfg.brake, {
  runId, agentId: BigInt(plan.agentId), agent: plan.agent as Hex, agentExpiry: validBefore, maxStops: plan.maxStops, alarmAt: plan.alarmAt, pairs,
});
const rc = await pub.waitForTransactionReceipt({ hash: openTx });
if (rc.status !== "success") throw new Error(`openRun reverted ${openTx}`);
log("openRun sent by the payer's own wallet", { tx: openTx });
await api(`/api/runs/${created.id}/opened`, { body: { tx: openTx }, token: created.token });
type RunView = { decisions: { idx: number; verdict: string }[]; lines: { idx: number; status: string; paidTx: string | null; stopTx: string | null; proofTx: string | null }[]; jobs: { status: string }[] };
const view = () => api<RunView>(`/api/runs/${created.id}`, { token: created.token });
const until = async (what: string, ok: (r: RunView) => boolean) => {
  for (let i = 0; i < 120; i++) { const r = await view(); if (ok(r)) return r; await sleep(2000); }
  throw new Error(`timeout: ${what}`);
};
await until("Monday review", (r) => r.decisions.length >= 4 && !r.jobs.some((j) => j.status !== "done" && j.status !== "failed"));
log("Monday review done");
await api(`/api/runs/${created.id}/inbox`, { body: { seed: "E4" }, token: created.token });
const stopped = await until("line 3 stop", (r) => r.lines.some((l) => l.idx === 2 && l.stopTx));
log("line 3 stopped by the agent", { stopTx: stopped.lines[2]!.stopTx });
let pd: { notYet: unknown[]; batchTx?: string };
for (;;) {
  pd = await api(`/api/runs/${created.id}/payday?wait=1&sweep=1`, { method: "POST", body: {}, token: created.token });
  if (pd.notYet.length && !pd.batchTx) { await sleep(5000); continue; }
  break;
}
const final = await view();
log("payday: keeper paid with the payer's signatures", { batchTx: pd.batchTx, lines: final.lines.map((l) => ({ idx: l.idx + 1, status: l.status, paidTx: l.paidTx, proofTx: l.proofTx })) });
const out = join(REPO_ROOT, "evidence", `sign-local-${cfg.deployment}.json`);
writeFileSync(out, JSON.stringify({ deployment: cfg.deployment, payer: account.address, run: created.id, runId, openTx, steps, note: "payer key never left this process; server received signatures + the openRun tx hash only" }, null, 2) + "\n");
console.log(`wrote ${out}`);
