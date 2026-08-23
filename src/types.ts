import { z } from "zod";

/** Blockchains traql can score. Mirrors the `Chain` enum in the traql OpenAPI spec. */
export const CHAINS = ["ethereum", "bsc", "tron", "ton", "bitcoin"] as const;
export type Chain = (typeof CHAINS)[number];

/** Risk bands the score maps onto. */
export const BANDS = ["clean", "low", "elevated", "high", "critical"] as const;
export type Band = (typeof BANDS)[number];

/** Chains for which the API can screen an already-broadcast transaction by hash. */
export const BY_HASH_CHAINS: readonly Chain[] = ["ethereum", "bsc", "tron", "ton"];

const chainField = z
  .enum(CHAINS)
  .describe("Blockchain network the subject belongs to.");

/** Input accepted by the `check_address` tool. */
export const checkAddressInput = {
  chain: chainField,
  address: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Address in the chain's native format: 0x-hex for ethereum and bsc, base58 starting with T for tron, EQ/UQ for ton, and legacy or bech32 for bitcoin.",
    ),
};

/** Input accepted by the `screen_transaction` tool. */
export const screenTransactionInput = {
  chain: chainField,
  tx_hash: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Hash of an already-broadcast transaction. Mutually exclusive with `from`/`to`. Supported on ethereum, bsc, tron and ton only.",
    ),
  from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Sender address, for screening a transfer that has not been broadcast yet."),
  to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Recipient address, for screening a transfer that has not been broadcast yet."),
  amount: z
    .string()
    .trim()
    .regex(/^\d+$/, "amount must be a non-negative integer in the asset's base units")
    .optional()
    .describe(
      "Optional transfer amount as an integer string in the asset's base units (for example 1000000 for 1 USDT, which has 6 decimals). Never a decimal fraction.",
    ),
  asset: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional asset or token symbol being transferred, for example USDT."),
};

const subjectSchema = z
  .looseObject({
    type: z.string().describe("Either `address` or `transaction`."),
    chain: z.string(),
    address: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    amount: z.string().optional(),
    asset: z.string().optional(),
    tx_hash: z.string().optional(),
  })
  .describe("Echo of the canonical subject that was scored.");

const signalSchema = z.looseObject({
  code: z.string().describe("Stable machine-readable signal identifier, e.g. OFAC_SDN_DIRECT."),
  message: z.string(),
  contribution: z.number().describe("How much this signal added to the final score."),
  category: z.string().optional(),
  source: z.string().optional().describe("Data feed the signal came from, e.g. ofac_sdn."),
  entity: z.string().optional().describe("Named entity behind the signal, when known."),
  severity: z.number().optional(),
  confidence: z.number().optional().describe("Confidence in the underlying label, 0-1."),
  eff: z.number().optional().describe("Effective weight: severity x confidence, damped for indirect exposure."),
  side: z.string().optional().describe("For transactions, which side of the transfer the signal applies to."),
  config_version: z.number().optional(),
});

const resultSchema = z.looseObject({
  score: z.number().describe("Risk score from 0 (clean) to 100 (critical)."),
  band: z.string().describe("Risk band: clean, low, elevated, high or critical."),
  flags: z.array(z.string()).describe("Risk categories that materially contributed to the score."),
  partial: z
    .boolean()
    .describe("True if a data source was degraded; treat the score as a lower bound, not a final verdict."),
  computed_at: z.string(),
  reason_summary: z
    .string()
    .optional()
    .describe("Keyless tier only: a single coarse reason phrase instead of itemized reasons."),
  reasons: z
    .array(signalSchema)
    .optional()
    .describe("API-key tier only: itemized signals that produced the score."),
});

/** Output shape shared by both tools; mirrors the API's `CheckResponse`. */
export const checkOutput = {
  subject: subjectSchema,
  result: resultSchema,
};

export type Subject = z.infer<typeof subjectSchema>;
export type Signal = z.infer<typeof signalSchema>;
export type Result = z.infer<typeof resultSchema>;

export interface CheckResponse {
  subject: Subject;
  result: Result;
}
