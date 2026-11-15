import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "@brake/engine/config";

/** Local runs read secrets from ~/.config/brake (never from the repo). */
export function loadLocalEnv() {
  const d = join(homedir(), ".config", "brake");
  loadEnvFiles(join(d, "wallets.env"), join(d, "app.env"), join(d, "neon.env"), join(d, "cron.env"));
  const key = join(d, "anthropic.key");
  return { anthropicKeyFile: key };
}
