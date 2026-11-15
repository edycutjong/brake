// pnpm sign:local — ONE non-custodial run. The payer key stays in this process: it signs every payment authorization and its
// paired cancel, and it sends openRun itself. The server (BASE_URL) only receives signatures — it verifies each one recovers to
// the payer — plus the openRun tx hash. It then reviews, stops line 3 on E4, and the keeper pays the rest with the signatures.
//
// Brake.openRun requires the payer to own the agent's ERC-8004 identity, so this payer (KILLTEST_B by default — a key the server
// never holds) first registers its OWN agent identity, binds the monitor agent's wallet to it (the agent key signs that binding,
// not the payer) and approves Brake. Only then does it sign the run. On a fork it tops itself up from the fork faucet; on the
// live chain the wallet must already hold tQDAY + tUSD8 (faucet — human step).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openRun, readTokenDomain, signRun } from "brake-signer";
import { loadLocalEnv } from "./env.js";
import { loadConfig, REPO_ROOT } from "@brake/engine/config";
import { aevumChain } from "@brake/engine/chain";

loadLocalEnv();
const base = process.env.BASE_URL ?? "http://localhost:3000";
const cfg = loadConfig();
const key = (process.env.SIGN_LOCAL_PRIVATE_KEY ?? process.env.KILLTEST_B_PRIVATE_KEY) as Hex | undefined;
if (!key) throw new Error("set SIGN_LOCAL_PRIVATE_KEY (or have KILLTEST_B_PRIVATE_KEY in ~/.config/brake/wallets.env)");
if (key.toLowerCase() === (process.env.DEMO_PAYER_PRIVATE_KEY ?? "").toLowerCase()) throw new Error("use a payer key the server does not hold");
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

// ---- own ERC-8004 agent identity (the payer must own the agentId it passes to openRun)
const idAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function approve(address to, uint256 tokenId)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
if (cfg.deployment === "fork") {
  // fork only: gas + 3 tUSD8 from an impersonated holder (never on the live chain)
  const funder = (process.env.FORK_FUNDER ?? "0x693E322361bdBC101F4028596e89aAcE407Bb09f") as Hex;
  const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  await rpc("anvil_setBalance", [account.address, "0x8AC7230489E80000"]);
  await rpc("anvil_impersonateAccount", [funder]);
  await rpc("anvil_setBalance", [funder, "0x8AC7230489E80000"]);
  const wl = createWalletClient({ account: funder, chain, transport: http(cfg.rpcUrl) });
  await pub.waitForTransactionReceipt({ hash: await wl.writeContract({ address: cfg.token, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [account.address, 3_000_000n] }) });
}
const bal = (await pub.readContract({ address: cfg.token, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
if (bal < 1_000_000n || (await pub.getBalance({ address: account.address })) === 0n) throw new Error(`${account.address} needs tQDAY (gas) and ≥ 1 tUSD8 — claim at the QDay faucet`);
const agentKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!agentKey) throw new Error("AGENT_PRIVATE_KEY (the monitor agent's key, not the payer's) is needed once to bind the agent wallet");
const agentAcct = privateKeyToAccount(agentKey);
const sim = await pub.simulateContract({ account, address: cfg.identity, abi: idAbi, functionName: "register", args: ["https://github.com/edycutjong/brake#agent-own"] });
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
const ownAgentId = sim.result;
const now = (await pub.getBlock()).timestamp;
const deadline = now + 240n;
const bindSig = await agentAcct.signTypedData({
  domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: cfg.chainId, verifyingContract: cfg.identity },
  types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
  primaryType: "AgentWalletSet",
  message: { agentId: ownAgentId, newWallet: agentAcct.address, owner: account.address, deadline },
});
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: cfg.identity, abi: idAbi, functionName: "setAgentWallet", args: [ownAgentId, agentAcct.address, deadline, bindSig] }) });
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: cfg.identity, abi: idAbi, functionName: "approve", args: [cfg.brake, ownAgentId] }) });
log("own ERC-8004 agent identity registered, agent wallet bound, Brake approved", { agentId: ownAgentId.toString(), owner: account.address });

const plan = await api<{ validAfter: string; validBefore: string; agentId: string; agent: string; maxStops: number; alarmAt: number; lines: { to: Hex; value: string }[] }>("/api/plan?scenario=hero");
log("plan fetched", { lines: plan.lines.length });
const validAfter = BigInt(plan.validAfter);
const validBefore = BigInt(plan.validBefore);
const pairs = await signRun(account, await readTokenDomain(pub, cfg.token), { validAfter, validBefore, lines: plan.lines.map((l) => ({ to: l.to, value: BigInt(l.value) })) });
log("signed locally (payment + paired cancel per line)", { payer: account.address, lines: pairs.length });
const runId = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
const created = await api<{ id: string; token: string }>("/api/runs", {
  body: {
    mode: "wallet", scenario: "hero", payer: account.address, runId, agentId: ownAgentId.toString(), validAfter: plan.validAfter, validBefore: plan.validBefore,
    pairs: pairs.map((p) => ({ to: p.authorization.to, value: p.authorization.value.toString(), nonce: p.authorization.nonce, payment: p.payment.signature, cancel: p.cancel.signature })),
  },
});
log("server accepted signed authorizations (it never saw the key)", { run: created.id });
const openTx = await openRun(wallet, cfg.brake, {
  runId, agentId: ownAgentId, agent: agentAcct.address, agentExpiry: validBefore, maxStops: plan.maxStops, alarmAt: plan.alarmAt, pairs,
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
