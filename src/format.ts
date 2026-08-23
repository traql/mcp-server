import type { CheckResponse, Signal, Subject } from "./types.js";

/** Signals shown in full before the tail is summarised as a count. */
const MAX_SIGNALS = 12;

/**
 * Renders a verdict as compact text for the model.
 *
 * The same data also travels in `structuredContent`; this rendering exists so a
 * model that only reads the text block still gets the score, the band and the
 * reasons behind them without having to parse JSON.
 */
export function formatCheck(res: CheckResponse): string {
  const { subject, result } = res;
  const lines: string[] = [];

  lines.push(describeSubject(subject));
  lines.push(`RISK ${result.score}/100 — ${String(result.band).toUpperCase()}`);

  if (result.flags?.length) {
    lines.push(`Flags: ${result.flags.join(", ")}`);
  } else {
    lines.push("Flags: none");
  }

  if (result.partial) {
    lines.push(
      "! Partial data: one or more sources were degraded, so this score is a lower bound rather than a final verdict.",
    );
  }

  const reasons = result.reasons ?? [];
  if (reasons.length > 0) {
    const ranked = [...reasons].sort(
      (a, b) => Math.abs(numeric(b.contribution)) - Math.abs(numeric(a.contribution)),
    );
    lines.push("", `Signals (${reasons.length}):`);
    for (const signal of ranked.slice(0, MAX_SIGNALS)) {
      lines.push(`  ${formatSignal(signal)}`);
    }
    if (ranked.length > MAX_SIGNALS) {
      lines.push(`  ... and ${ranked.length - MAX_SIGNALS} more`);
    }
  } else if (result.reason_summary) {
    lines.push("", `Reason: ${result.reason_summary}`);
    lines.push("Itemized signals need an API key — set TRAQL_API_KEY to get them.");
  }

  if (result.computed_at) {
    lines.push("", `Computed at ${result.computed_at}.`);
  }

  return lines.join("\n");
}

function describeSubject(subject: Subject): string {
  const chain = subject.chain ?? "unknown chain";

  if (subject.type === "transaction") {
    if (subject.tx_hash) {
      return `${chain} transaction ${subject.tx_hash}`;
    }
    const transfer = `${subject.from ?? "?"} -> ${subject.to ?? "?"}`;
    const value = [subject.amount, subject.asset].filter(Boolean).join(" ");
    return value ? `${chain} transfer ${transfer} (${value})` : `${chain} transfer ${transfer}`;
  }

  return `${chain} address ${subject.address ?? "?"}`;
}

function formatSignal(signal: Signal): string {
  const contribution = numeric(signal.contribution);
  const sign = contribution >= 0 ? "+" : "";
  const origin = [signal.category, signal.source].filter(Boolean).join("/");

  let line = `${sign}${contribution}`.padEnd(5);
  if (origin) line += `[${origin}] `;
  line += signal.code;
  if (signal.side && signal.side !== "direct") line += ` (${signal.side} side)`;
  if (signal.message) line += ` — ${signal.message}`;

  const notes: string[] = [];
  if (signal.entity) notes.push(`entity ${signal.entity}`);
  // Behavioural signals carry no label confidence and report it as 0; printing
  // "confidence 0.00" next to them reads as a data fault rather than an absence.
  if (typeof signal.confidence === "number" && signal.confidence > 0) {
    notes.push(`confidence ${signal.confidence.toFixed(2)}`);
  }
  if (notes.length) line += ` [${notes.join(", ")}]`;

  return line;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
