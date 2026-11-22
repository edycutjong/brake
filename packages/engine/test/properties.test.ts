// Property-based checks of the agent decision pipeline (fast-check).
// Each property runs RUNS generated cases; the total is what README/JUDGE.md quote (3 × 10,000 = 30,000).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Address, Hex } from "viem";
import { promptSafe } from "../src/agent/model.js";
import { decide, verifyFindings } from "../src/agent/pipeline.js";
import { INTENTS, type Finding, type LineCtx, type Message, type RuleHit, type RuleId } from "../src/agent/types.js";

const RUNS = 10_000;
const RULE_IDS: RuleId[] = ["R-BL", "R-DOM", "R-SRC", "R-CHG", "R-AMT", "R-DSP", "R-DUP"];
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;

const lineCtx = (idx: number, payeeChanged: boolean): LineCtx => ({
  idx,
  vendor: {
    id: "v1",
    name: "Vendor",
    domain: "vendor.example",
    payee: PAYEE,
    genuinePayee: PAYEE,
    payeeChangedAt: payeeChanged ? new Date("2026-11-17T00:00:00Z") : null,
    payeeChangeSource: null,
    payeeChangeVerified: null,
  },
  invoiceId: "INV-1",
  invoiceAmountUnits: 1_000_000n,
  invoiceStatus: "open",
  payee: PAYEE,
  amountUnits: 1_000_000n,
  nonce: `0x${"11".repeat(32)}` as Hex,
  status: "OPEN",
  evidenceRev: 0,
  windowStart: new Date("2026-11-16T00:00:00Z"),
});

const arbRule: fc.Arbitrary<RuleHit> = fc.record({
  id: fc.constantFrom(...RULE_IDS),
  reason: fc.string({ minLength: 1, maxLength: 24 }),
  detail: fc.string({ maxLength: 40 }),
});

// arbitrary model output: any intent, any line, any quotes (adversarial text included)
const arbFinding = (lines: number[]): fc.Arbitrary<Finding> =>
  fc.record({
    line: fc.constantFrom(...lines),
    intent: fc.constantFrom(...INTENTS),
    quotes: fc.array(fc.record({ messageId: fc.constantFrom("m1", "m2", "mx"), text: fc.string({ maxLength: 30 }) }), {
      maxLength: 3,
    }),
    note: fc.string({ maxLength: 40 }),
  });

describe("agent pipeline properties (fast-check, 3 × 10,000 cases)", () => {
  it("no model output can turn a rule STOP into anything else (invariant I4)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.array(arbRule, { minLength: 1, maxLength: 4 }),
        fc.array(arbFinding([0, 1, 2, 3, 4]), { maxLength: 6 }),
        fc.array(arbFinding([0, 1, 2, 3, 4]), { maxLength: 6 }),
        (idx, changed, rules, verified, unsupported) => {
          const d = decide(lineCtx(idx, changed), rules, verified, unsupported);
          expect(d.verdict).toBe("STOP");
          expect(d.reason).toBe(rules[0]!.reason);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("a fabricated quote never verifies", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.constantFrom(...INTENTS),
        (subject, body, quote, intent) => {
          const raw = `${subject}\n${body}`;
          const safe = `${promptSafe(subject)}\n${promptSafe(body)}`;
          fc.pre(quote.trim().length > 0 && !raw.includes(quote) && !safe.includes(quote));
          const msg: Message = {
            id: "m1",
            fromAddr: "a@vendor.example",
            fromDomain: "vendor.example",
            subject,
            body,
            receivedAt: new Date("2026-11-17T00:00:00Z"),
          };
          const f: Finding = { line: 0, intent, quotes: [{ messageId: "m1", text: quote }], note: "" };
          const { verified, unsupported } = verifyFindings([f], new Map([[0, [msg]]]));
          expect(verified).toHaveLength(0);
          expect(unsupported).toHaveLength(1);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("findings that did not verify never yield ALLOW (fail-closed) and never STOP on their own", () => {
    const nonBenign = INTENTS.filter((i) => i !== "BENIGN");
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(
          fc.record({
            line: fc.constant(0),
            intent: fc.constantFrom(...nonBenign),
            quotes: fc.constant<Finding["quotes"]>([]),
            note: fc.string({ maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (changed, unsupported) => {
          const d = decide(lineCtx(0, changed), [], [], unsupported);
          expect(d.verdict).toBe("HOLD");
        },
      ),
      { numRuns: RUNS },
    );
  });
});
