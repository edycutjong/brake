// I1: no component the model can influence holds a payment signature or a key. The agent module (src/agent) receives
// line params + messages only: it must not import the DB, signatures, chain wallets, executor or keeper.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT = join(import.meta.dirname, "..", "src", "agent");
const FORBIDDEN = [/from "\.\.\/(db|runs|chain|executor|keeper|reconciler|jobs|api|config)\.js"/, /signatures/, /PRIVATE_KEY/, /privateKeyToAccount|mnemonicToAccount/];

describe("I1 — agent module boundary", () => {
  for (const f of readdirSync(AGENT).filter((x) => x.endsWith(".ts"))) {
    it(`${f} has no path to signatures, keys or the database`, () => {
      const src = readFileSync(join(AGENT, f), "utf8");
      for (const re of FORBIDDEN) expect(src, `${f} matches ${re}`).not.toMatch(re);
    });
  }
});
