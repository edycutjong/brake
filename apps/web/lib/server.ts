import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { after } from "next/server";
import { createApi, connect, loadConfig, loadEnvFiles, makeChain, modelFromEnv } from "@brake/engine";

// the engine finds seed/ and evidence/ through BRAKE_ROOT (the repo root; apps/web is two levels down)
process.env.BRAKE_ROOT ??= resolve(process.cwd(), "../..");
if (!process.env.VERCEL) {
  // local dev reads secrets from ~/.config/brake, never from the tree
  const d = join(homedir(), ".config", "brake");
  loadEnvFiles(join(d, "wallets.env"), join(d, "app.env"), join(d, "neon.env"), join(d, "cron.env"));
}

type Handler = (req: Request) => Promise<Response>;
const g = globalThis as unknown as { __brakeApi?: Handler };

/** One engine instance per server process (pool + chain clients are reused across requests). */
export function api(): Handler {
  if (!g.__brakeApi) {
    const cfg = loadConfig();
    g.__brakeApi = createApi({
      db: connect(cfg.databaseUrl),
      ctx: makeChain(cfg),
      model: modelFromEnv(),
      // after() keeps the function alive until the review / payday work finishes, after the response is sent
      defer: (p) => after(() => p.catch(() => {})),
    });
  }
  return g.__brakeApi;
}
