// pnpm db:migrate — apply packages/engine/src/schema.sql to DATABASE_URL (idempotent). Run once per database (Neon), not at request time.
import { loadLocalEnv } from "./env.js";
import { connect, migrate } from "@brake/engine/db";

loadLocalEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set (~/.config/brake/neon.env)");
const db = connect(url);
await migrate(db);
console.log("schema applied");
await db.end();
