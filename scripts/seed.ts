import { loadLocalEnv } from "./env.js";
import { loadConfig } from "@brake/engine/config";
import { connect } from "@brake/engine/db";
import { seed } from "@brake/engine/seed";

loadLocalEnv();
const cfg = loadConfig();
if (!cfg.payeesMnemonic) throw new Error("PAYEES_MNEMONIC missing (~/.config/brake/app.env)");
const db = connect(cfg.databaseUrl);
const r = await seed(db, { mnemonic: cfg.payeesMnemonic, scale: cfg.seedScale });
console.log(`seeded ${r.vendors} vendors, ${r.invoices} invoices, ${r.mails} inbox templates (SEED_SCALE=${cfg.seedScale})`);
await db.end();
