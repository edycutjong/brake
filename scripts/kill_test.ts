/**
 * G1 kill test — can ANY caller submit a payer's pre-signed cancelAuthorization on tUSD8?
 *
 * Brake only works if an unrelated address (and a contract) can submit the payer's cancel. This script
 * proves it with real transactions, in the order the spec fixes:
 *   step 0  read name()/version(), rebuild the EIP-712 domain, compare with DOMAIN_SEPARATOR();
 *           record the implementation address + code hash
 *   control eth_call the cancel from the authorizer A (must succeed: proves the signature) and from B
 *   step 1  submit the cancel from unrelated EOA B
 *   step 2  repeat with a fresh pair through CancelRelay (a contract caller, as Brake will be)
 *   step 3  AuthorizationCanceled fired, authorizationState flipped, the transfer then reverts
 *   step 5  positive control: an un-cancelled pair reverts before validAfter and pays after it via Multicall3
 *
 * Kill rule: if the cancel simulates OK from A but fails from B or the relay, Brake is dead.
 *
 * Usage:
 *   live:  RPC_URL=https://rpc-test.qday.info pnpm kill-test
 *   fork:  anvil --fork-url https://rpc-test.qday.info --port 8545   (separate shell)
 *          FORK=1 RPC_URL=http://127.0.0.1:8545 pnpm kill-test
 * Keys come from the environment (A_PRIVATE_KEY = payer, B_PRIVATE_KEY = unrelated caller). Never commit them.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TUSD8_ADDRESS, eip3009Abi, readTokenDomain, signPair, type SignedPair } from "brake-signer";

const here = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "https://rpc-test.qday.info";
const FORK = process.env.FORK === "1";
const VALID_AFTER_SECS = BigInt(process.env.VALID_AFTER_SECS ?? "900"); // spec: now + 15 min
const VALUE = BigInt(process.env.VALUE ?? "10000"); // 0.01 tUSD8 (6 dp) per line
const OUT = resolve(here, "..", "evidence", FORK ? "g1-fork.json" : "g1.json");
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
// FiatTokenProxy (AdminUpgradeabilityProxy) implementation slot = keccak256("org.zeppelinos.proxy.implementation")
const ZOS_IMPL_SLOT: Hex = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
// fork only: an existing tUSD8 holder impersonated to fund A (never used live)
const FORK_FUNDER: Address = (process.env.FORK_FUNDER ?? "0x693E322361bdBC101F4028596e89aAcE407Bb09f") as Address;

const aevum = defineChain({
  id: 44005,
  name: "Aevum Testnet",
  nativeCurrency: { name: "QDAY", symbol: "QDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer-test.qday.info" } },
});

const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const relayAbi = parseAbi(["function cancel(address token, address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]);

function key(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in environment`);
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
}

const A = privateKeyToAccount(key("A_PRIVATE_KEY"));
const B = privateKeyToAccount(key("B_PRIVATE_KEY"));
const PAYEE: Address = (process.env.PAYEE ?? "0x000000000000000000000000000000000000bEEF") as Address;

const pub = createPublicClient({ chain: aevum, transport: http(RPC_URL) });
const walletB = createWalletClient({ account: B, chain: aevum, transport: http(RPC_URL) });
const test = createTestClient({ chain: aevum, mode: "anvil", transport: http(RPC_URL) });

type Step = { step: string; ok: boolean; detail: Record<string, unknown> };
const steps: Step[] = [];
const record = (step: string, ok: boolean, detail: Record<string, unknown>) => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
};

async function revertReason(from: Address, to: Address, data: Hex): Promise<string | null> {
  try {
    await pub.call({ account: from, to, data });
    return null;
  } catch (e) {
    const err = e as { shortMessage?: string; details?: string; message: string };
    const m = `${err.details ?? ""} ${err.shortMessage ?? ""} ${err.message}`;
    const fiat = m.match(/FiatToken[A-Za-z0-9]*: [A-Za-z ]+?(?= Execution|\.|$)/);
    return fiat ? fiat[0].replace(/ Execution.*$/, "").trim() : (err.shortMessage ?? err.message).split("\n")[0];
  }
}

function cancelData(p: SignedPair): Hex {
  return encodeFunctionData({
    abi: eip3009Abi,
    functionName: "cancelAuthorization",
    args: [p.authorization.from, p.authorization.nonce, p.cancel.v, p.cancel.r, p.cancel.s],
  });
}
function transferData(p: SignedPair): Hex {
  const a = p.authorization;
  return encodeFunctionData({
    abi: eip3009Abi,
    functionName: "transferWithAuthorization",
    args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, p.payment.v, p.payment.r, p.payment.s],
  });
}

async function send(to: Address, data: Hex, gas?: bigint) {
  const hash = await walletB.sendTransaction({ to, data, ...(gas ? { gas } : {}) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

function eventsOf(receipt: { logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] | [] }[] }) {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== TUSD8_ADDRESS.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: eip3009Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      out.push({ name: d.eventName, args: d.args as Record<string, unknown> });
    } catch {
      /* not an EIP-3009 event */
    }
  }
  return out;
}

const authState = (nonce: Hex) =>
  pub.readContract({ address: TUSD8_ADDRESS, abi: eip3009Abi, functionName: "authorizationState", args: [A.address, nonce] });
const balance = (who: Address) =>
  pub.readContract({ address: TUSD8_ADDRESS, abi: eip3009Abi, functionName: "balanceOf", args: [who] });

async function main() {
  const startedAt = new Date().toISOString();
  const forkBlock = await pub.getBlockNumber();
  console.log(`G1 kill test · ${FORK ? "FORK (anvil, not live)" : "LIVE"} · rpc ${RPC_URL} · block ${forkBlock}`);
  console.log(`A (payer) ${A.address} · B (unrelated caller) ${B.address}`);

  if (FORK) {
    await test.setBalance({ address: A.address, value: 10n ** 18n });
    await test.setBalance({ address: B.address, value: 10n ** 18n });
    await test.setBalance({ address: FORK_FUNDER, value: 10n ** 18n });
    await test.impersonateAccount({ address: FORK_FUNDER });
    const fund = createWalletClient({ account: FORK_FUNDER, chain: aevum, transport: http(RPC_URL) });
    const h = await fund.writeContract({
      address: TUSD8_ADDRESS,
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [A.address, VALUE * 10n],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await test.stopImpersonatingAccount({ address: FORK_FUNDER });
    console.log(`fork setup: gas to A/B via anvil_setBalance; ${VALUE * 10n} tUSD8 base units to A from ${FORK_FUNDER}`);
  }

  // ---- step 0: domain + implementation identity
  const domain = await readTokenDomain(pub, TUSD8_ADDRESS); // throws on mismatch
  const separator = await pub.readContract({ address: TUSD8_ADDRESS, abi: eip3009Abi, functionName: "DOMAIN_SEPARATOR" });
  const implWord = await pub.getStorageAt({ address: TUSD8_ADDRESS, slot: ZOS_IMPL_SLOT });
  const impl = `0x${(implWord ?? "0x").slice(-40)}` as Address;
  const implCode = await pub.getCode({ address: impl });
  const implCodeHash = implCode ? keccak256(implCode) : null;
  record("0 domain", true, { name: domain.name, version: domain.version, chainId: domain.chainId, separator, impl, implCodeHash });

  const bal0 = await balance(A.address);
  if (bal0 < VALUE) throw new Error(`A holds ${bal0} tUSD8 base units < ${VALUE}; fund A first`);

  const now = (await pub.getBlock()).timestamp;
  const validAfter = now + VALID_AFTER_SECS;
  const validBefore = now + 86_400n;
  const line = { to: PAYEE, value: VALUE, validAfter, validBefore };
  const p1 = await signPair(A, domain, line);
  const p2 = await signPair(A, domain, line);
  const p3 = await signPair(A, domain, line);

  // ---- control: same valid cancel signature simulated from A and from B
  const simA = await revertReason(A.address, TUSD8_ADDRESS, cancelData(p1));
  const simB = await revertReason(B.address, TUSD8_ADDRESS, cancelData(p1));
  record("control eth_call cancel", simA === null && simB === null, { fromA: simA ?? "ok", fromB: simB ?? "ok" });
  if (simA !== null) throw new Error(`cancel fails even from the authorizer (signing bug, not a caller gate): ${simA}`);
  if (simB !== null) {
    record("KILL", false, { reason: "cancel simulates from A but not from B — isolated caller restriction" });
    return finish(startedAt, forkBlock, "KILL");
  }

  // ---- step 1: cancel from unrelated EOA B
  const c1 = await send(TUSD8_ADDRESS, cancelData(p1));
  const ev1 = eventsOf(c1.receipt);
  const s1 = await authState(p1.authorization.nonce);
  const ok1 = c1.receipt.status === "success" && ev1.some((e) => e.name === "AuthorizationCanceled") && s1;
  record("1 cancel from EOA B", ok1, { tx: c1.hash, status: c1.receipt.status, events: ev1.map((e) => e.name), authorizationState: s1 });
  if (!ok1) {
    record("KILL", false, { reason: "EOA B could not submit A's valid cancel" });
    return finish(startedAt, forkBlock, "KILL");
  }

  // ---- step 2: cancel through a contract caller
  const artifact = JSON.parse(readFileSync(resolve(here, "..", "out", "CancelRelay.sol", "CancelRelay.json"), "utf8"));
  const deployHash = await walletB.deployContract({ abi: relayAbi, bytecode: artifact.bytecode.object as Hex });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const relay = deployRcpt.contractAddress as Address;
  const relayData = encodeFunctionData({
    abi: relayAbi,
    functionName: "cancel",
    args: [TUSD8_ADDRESS, A.address, p2.authorization.nonce, p2.cancel.v, p2.cancel.r, p2.cancel.s],
  });
  const simRelay = await revertReason(B.address, relay, relayData);
  const c2 = await send(relay, relayData, simRelay ? 200_000n : undefined);
  const ev2 = eventsOf(c2.receipt);
  const s2 = await authState(p2.authorization.nonce);
  const ok2 = c2.receipt.status === "success" && ev2.some((e) => e.name === "AuthorizationCanceled") && s2;
  record("2 cancel via CancelRelay contract", ok2, {
    relay,
    deployTx: deployHash,
    tx: c2.hash,
    status: c2.receipt.status,
    simulation: simRelay ?? "ok",
    events: ev2.map((e) => e.name),
    authorizationState: s2,
  });
  if (!ok2) {
    record("KILL", false, { reason: "a contract caller could not submit A's valid cancel" });
    return finish(startedAt, forkBlock, "KILL");
  }

  // a second cancel of the same nonce must revert (idempotency is Brake's job, not the token's)
  const again = await revertReason(B.address, TUSD8_ADDRESS, cancelData(p1));
  record("1b re-cancel reverts", again !== null, { reason: again });

  // ---- step 5a: un-cancelled pair submitted before validAfter reverts
  const earlyReason = await revertReason(B.address, TUSD8_ADDRESS, transferData(p3));
  const early = await send(TUSD8_ADDRESS, transferData(p3), 200_000n);
  record("5a early submit reverts", early.receipt.status === "reverted", {
    tx: early.hash,
    status: early.receipt.status,
    reason: earlyReason,
  });

  // ---- wait until validAfter
  if (FORK) {
    await test.increaseTime({ seconds: Number(VALID_AFTER_SECS) + 5 });
    await test.mine({ blocks: 1 });
  } else {
    for (;;) {
      const t = (await pub.getBlock()).timestamp;
      if (t > validAfter) break;
      console.log(`waiting for validAfter: ${validAfter - t}s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  // ---- step 3: cancelled transfers now revert
  for (const [name, p] of [
    ["3a transfer of EOA-cancelled pair reverts", p1],
    ["3b transfer of relay-cancelled pair reverts", p2],
  ] as const) {
    const reason = await revertReason(B.address, TUSD8_ADDRESS, transferData(p));
    const tx = await send(TUSD8_ADDRESS, transferData(p), 200_000n);
    record(name, tx.receipt.status === "reverted", { tx: tx.hash, status: tx.receipt.status, reason });
  }

  // ---- step 5b: un-cancelled pair pays through Multicall3 aggregate3
  const before = await balance(PAYEE);
  const mcData = encodeFunctionData({
    abi: multicallAbi,
    functionName: "aggregate3",
    args: [[{ target: TUSD8_ADDRESS, allowFailure: false, callData: transferData(p3) }]],
  });
  const pay = await send(MULTICALL3, mcData);
  const after = await balance(PAYEE);
  const ev5 = eventsOf(pay.receipt);
  const ok5 = pay.receipt.status === "success" && after - before === VALUE && ev5.some((e) => e.name === "AuthorizationUsed");
  record("5b pay via Multicall3 after validAfter", ok5, {
    tx: pay.hash,
    status: pay.receipt.status,
    payeeDelta: (after - before).toString(),
    events: ev5.map((e) => e.name),
  });

  const allOk = steps.every((s) => s.ok);
  return finish(startedAt, forkBlock, allOk ? "PASS" : "FIX_AND_RERUN");
}

function finish(startedAt: string, block: bigint, verdict: "PASS" | "KILL" | "FIX_AND_RERUN") {
  const out = {
    gate: "G1 cancel authority (kill test)",
    mode: FORK ? "fork (anvil fork of Aevum testnet 44005; NOT live tx hashes)" : "live (Aevum testnet 44005)",
    rpc: FORK ? `anvil fork of https://rpc-test.qday.info @ block ${block}` : RPC_URL,
    explorer: FORK ? null : "https://explorer-test.qday.info/tx/",
    token: TUSD8_ADDRESS,
    payer: A.address,
    caller: B.address,
    payee: PAYEE,
    value: VALUE.toString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    steps,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`\nG1 verdict: ${verdict} → ${OUT}`);
  if (verdict !== "PASS") process.exitCode = verdict === "KILL" ? 2 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
