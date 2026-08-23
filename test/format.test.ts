import { describe, expect, it } from "vitest";

import { formatCheck } from "../src/format.js";
import type { CheckResponse, Signal, Subject } from "../src/types.js";

// --- fixtures ---------------------------------------------------------

function subject(overrides: Partial<Subject> = {}): Subject {
  return { type: "address", chain: "ethereum", address: "0xabc", ...overrides };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    code: "OFAC_SDN_DIRECT",
    message: "Direct match on OFAC SDN list",
    contribution: 92,
    ...overrides,
  };
}

function response(overrides: {
  subject?: Partial<Subject>;
  result?: Partial<CheckResponse["result"]>;
} = {}): CheckResponse {
  return {
    subject: subject(overrides.subject),
    result: {
      score: 92,
      band: "critical",
      flags: ["sanctions"],
      partial: false,
      computed_at: "2026-08-23T00:00:00Z",
      ...overrides.result,
    },
  };
}

describe("formatCheck", () => {
  it("renders a tier-1 address check with itemized reasons", () => {
    const text = formatCheck(response({ result: { reasons: [signal()] } }));

    expect(text).toContain("ethereum address 0xabc");
    expect(text).toContain("RISK 92/100 — CRITICAL"); // em dash U+2014
    expect(text).toContain("Flags: sanctions");
    expect(text).toContain("Signals (1):");
    expect(text).toContain("OFAC_SDN_DIRECT");
    expect(text).toContain("Computed at 2026-08-23T00:00:00Z.");
  });

  it("sorts signals by descending |contribution|", () => {
    const text = formatCheck(
      response({
        result: {
          reasons: [
            signal({ code: "SMALL", contribution: 5 }),
            signal({ code: "BIG", contribution: 92 }),
            signal({ code: "MID", contribution: 40 }),
          ],
        },
      }),
    );

    const bigPos = text.indexOf("BIG");
    const midPos = text.indexOf("MID");
    const smallPos = text.indexOf("SMALL");
    expect(bigPos).toBeGreaterThan(-1);
    expect(bigPos).toBeLessThan(midPos);
    expect(midPos).toBeLessThan(smallPos);
  });

  it("truncates to 12 signal lines and appends an overflow count", () => {
    const reasons = Array.from({ length: 15 }, (_, i) =>
      signal({ code: `SIG_${i}`, contribution: 15 - i }),
    );
    const text = formatCheck(response({ result: { reasons } }));
    const lines = text.split("\n");

    const signalLines = lines.filter((l) => /^  [+-]?\d/.test(l));
    expect(signalLines).toHaveLength(12);
    expect(text).toContain("... and 3 more");
  });

  it("renders a tier-0 (keyless) check with reason_summary instead of reasons", () => {
    const text = formatCheck(
      response({ result: { reason_summary: "matches a sanctioned entity", reasons: undefined } }),
    );

    expect(text).toContain("Reason: matches a sanctioned entity");
    expect(text).toContain("TRAQL_API_KEY");
    expect(text).not.toContain("Signals (");
  });

  it("renders 'Flags: none' when flags is empty", () => {
    const text = formatCheck(response({ result: { flags: [] } }));
    expect(text).toContain("Flags: none");
  });

  it("prefixes partial results with a warning line", () => {
    const text = formatCheck(response({ result: { partial: true } }));
    expect(text.split("\n").some((l) => l.startsWith("! Partial data:"))).toBe(true);
  });

  it("describes a transaction subject with from/to/amount/asset", () => {
    const text = formatCheck(
      response({
        subject: {
          type: "transaction",
          chain: "tron",
          from: "TFrom",
          to: "TTo",
          amount: "1000000000",
          asset: "USDT",
        },
      }),
    );
    expect(text).toContain("tron transfer TFrom -> TTo (1000000000 USDT)");
  });

  it("describes a transaction subject with only a tx_hash", () => {
    const text = formatCheck(
      response({ subject: { type: "transaction", chain: "tron", tx_hash: "0xhash" } }),
    );
    expect(text).toContain("tron transaction 0xhash");
  });

  it("prints confidence only when the signal actually carries one", () => {
    // Behavioural signals report confidence: 0, which is an absence rather than
    // a measurement, so it must not be rendered.
    const scored = formatCheck(response({ result: { reasons: [signal({ confidence: 0.8 })] } }));
    expect(scored).toContain("confidence 0.80");

    const behavioural = formatCheck(
      response({ result: { reasons: [signal({ code: "behavior.pass_through", confidence: 0 })] } }),
    );
    expect(behavioural).not.toContain("confidence");

    const absent = formatCheck(response({ result: { reasons: [signal()] } }));
    expect(absent).not.toContain("confidence");
  });

  it("shows the side annotation only for non-direct signals", () => {
    const toSide = formatCheck(response({ result: { reasons: [signal({ side: "to" })] } }));
    expect(toSide).toContain("(to side)");

    const directSide = formatCheck(response({ result: { reasons: [signal({ side: "direct" })] } }));
    expect(directSide).not.toContain("(direct side)");
  });
});
