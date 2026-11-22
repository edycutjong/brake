// Regression tests for the two CodeQL findings fixed on 2026-11-22 (code scanning alerts #1 and #2).
import { describe, expect, it } from "vitest";
import { fromUnits } from "../src/fixtures.js";

describe("fromUnits (alert #1: polynomial ReDoS on trailing zeros)", () => {
  it("formats 6-decimal tUSD8 units and trims only the fraction", () => {
    expect(fromUnits(0n)).toBe("0");
    expect(fromUnits(1n)).toBe("0.000001");
    expect(fromUnits(500_000n)).toBe("0.5");
    expect(fromUnits(1_000_000n)).toBe("1");
    expect(fromUnits(100_000_000n)).toBe("100");
    expect(fromUnits(5_000_000_000n)).toBe("5000");
    expect(fromUnits(1_250_100_000n)).toBe("1250.1");
  });

  it("stays linear on a long run of zeros", () => {
    const t0 = performance.now();
    expect(fromUnits(10n ** 50_000n)).toBe("1" + "0".repeat(50_000 - 6));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
