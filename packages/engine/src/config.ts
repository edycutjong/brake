import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

/** BRAKE_ROOT overrides the source-relative root (bundled hosts such as Next.js/Vercel). */
export const REPO_ROOT = process.env.BRAKE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface Config {
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  explorer: string;
  token: Address;
  multicall3: Address;
  brake: Address;
  identity: Address;
  validation: Address;
  agentId: bigint;
  deployment: string;
  payerKey?: Hex;
  agentKey?: Hex;
  keeperKey?: Hex;
  payeesMnemonic?: string;
  sigEncKey?: string;
  cronSecret?: string;
  /** multiplies seed invoice amounts (faucet-limited testnet balance) */
  seedScale: number;
  /** demo payment window opens this many seconds after openRun */
  confirmations: number;
}

/** Contract addresses come from build/evidence/deploy-44005-<DEPLOYMENT>.json unless overridden by env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deployment = env.DEPLOYMENT ?? "fork";
  const f = join(REPO_ROOT, "evidence", `deploy-44005-${deployment}.json`);
  const d = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, string | number>) : {};
  const pick = (k: string, dk: string): string => {
    const v = env[k] ?? (d[dk] as string | undefined);
    if (!v) throw new Error(`missing ${k} (and no ${dk} in ${f})`);
    return String(v);
  };
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://localhost:5432/brake",
    rpcUrl: env.RPC_URL ?? (deployment === "fork" ? "http://127.0.0.1:8545" : "https://rpc-test.qday.info"),
    chainId: Number(env.CHAIN_ID ?? 44005),
    explorer: env.EXPLORER_URL ?? "https://explorer-test.qday.info",
    token: pick("TOKEN_ADDRESS", "token") as Address,
    multicall3: (env.MULTICALL3_ADDRESS ?? "0xcA11bde05977b3631167028862bE2a173976CA11") as Address,
    brake: pick("BRAKE_ADDRESS", "brake") as Address,
    identity: pick("IDENTITY_ADDRESS", "identityRegistry") as Address,
    validation: pick("VALIDATION_ADDRESS", "validationRegistry") as Address,
    agentId: BigInt(env.AGENT_ID ?? d.agentId ?? 0),
    deployment,
    payerKey: env.DEMO_PAYER_PRIVATE_KEY as Hex | undefined,
    agentKey: env.AGENT_PRIVATE_KEY as Hex | undefined,
    keeperKey: env.KEEPER_PRIVATE_KEY as Hex | undefined,
    payeesMnemonic: env.PAYEES_MNEMONIC,
    sigEncKey: env.SIG_ENC_KEY,
    cronSecret: env.CRON_SECRET,
    seedScale: Number(env.SEED_SCALE ?? 0.0001),
    confirmations: Number(env.CONFIRMATIONS ?? 3),
  };
}

/** Load KEY=VALUE files (e.g. ~/.config/brake/*.env) into process.env without overriding what is set. */
export function loadEnvFiles(...files: string[]) {
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]!] !== undefined) continue;
      process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
}
