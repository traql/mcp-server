import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TraqlClient, TraqlError, type ScreenTransactionRequest } from "./client.js";
import { formatCheck } from "./format.js";
import {
  BY_HASH_CHAINS,
  checkAddressInput,
  checkOutput,
  screenTransactionInput,
  type Chain,
  type CheckResponse,
} from "./types.js";

export const SERVER_NAME = "traql";

const CHECK_ADDRESS_DESCRIPTION = `Score a single crypto address for AML and compliance risk.

Returns a risk score from 0 (clean) to 100 (critical), the band it falls into, and the risk categories that drove it — sanctions, mixer, scam, darknet, stolen_funds, ransomware, high_risk_exchange and others. With an API key configured, the response also itemizes every contributing signal with its data source, severity and confidence, so the verdict can be explained rather than just asserted.

Use it before sending funds to an unfamiliar address, to triage an address a user pasted, to check a counterparty in an investigation, or to vet a deposit address. Covers Ethereum, BSC, TRON, TON and Bitcoin. Each call consumes one check from the configured traql account.`;

const SCREEN_TRANSACTION_DESCRIPTION = `Screen a transaction for AML and compliance risk by scoring both sides of the transfer.

Two modes, chosen by which arguments are given:
- Pre-flight — pass \`from\` and \`to\` (optionally \`amount\` and \`asset\`) to screen a transfer before it is broadcast. Works on every supported chain.
- By hash — pass only \`tx_hash\` to look up a transaction that is already on-chain. Supported on ethereum, bsc, tron and ton.

Returns the same score, band, flags and itemized signals as an address check, with each signal marked as applying to the sending or receiving side. Use it as a pre-send safety gate, or to review a payment that already went out. Each call consumes one check from the configured traql account.`;

/** Wires the traql tools onto an MCP server instance. */
export function createServer(client: TraqlClient, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        "traql scores crypto addresses and transactions for AML and compliance risk. Call check_address for a single address and screen_transaction for a transfer. Scores are advisory signals for triage, not a legal determination; a `partial: true` result means a data source was degraded and the score should be read as a lower bound.",
    },
  );

  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  server.registerTool(
    "check_address",
    {
      title: "Check address risk",
      description: CHECK_ADDRESS_DESCRIPTION,
      inputSchema: checkAddressInput,
      outputSchema: checkOutput,
      annotations,
    },
    async ({ chain, address }) => {
      try {
        return present(await client.checkAddress({ chain, address }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "screen_transaction",
    {
      title: "Screen transaction risk",
      description: SCREEN_TRANSACTION_DESCRIPTION,
      inputSchema: screenTransactionInput,
      outputSchema: checkOutput,
      annotations,
    },
    async (args) => {
      const request = buildScreenRequest(args);
      if ("error" in request) {
        return { content: [{ type: "text" as const, text: request.error }], isError: true };
      }
      try {
        return present(await client.screenTransaction(request.value));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

type ScreenArgs = {
  chain: Chain;
  tx_hash?: string;
  from?: string;
  to?: string;
  amount?: string;
  asset?: string;
};

/**
 * Resolves which screening mode the caller meant, rejecting ambiguous or
 * unsupported combinations locally so they cost neither a round trip nor a
 * check from the account balance.
 */
export function buildScreenRequest(
  args: ScreenArgs,
): { value: ScreenTransactionRequest } | { error: string } {
  const { chain, tx_hash, from, to, amount, asset } = args;

  if (tx_hash) {
    if (from || to) {
      return {
        error:
          "Ambiguous request: `tx_hash` screens a transaction that is already on-chain, while `from`/`to` screen one that has not been sent yet. Pass either `tx_hash` alone, or `from` and `to` together.",
      };
    }
    if (!BY_HASH_CHAINS.includes(chain)) {
      return {
        error: `Screening by hash is not supported on ${chain}. Supported chains for by-hash screening are ${BY_HASH_CHAINS.join(", ")}. On ${chain}, pass \`from\` and \`to\` instead.`,
      };
    }
    return { value: { chain, tx_hash } };
  }

  if (!from || !to) {
    return {
      error:
        "Missing arguments: screening a transfer that has not been broadcast needs both `from` and `to`. To screen a transaction that is already on-chain, pass `tx_hash` instead.",
    };
  }

  const value: ScreenTransactionRequest = { chain, from, to };
  if (amount) value.amount = amount;
  if (asset) value.asset = asset;
  return { value };
}

function present(res: CheckResponse) {
  return {
    content: [{ type: "text" as const, text: formatCheck(res) }],
    structuredContent: res as unknown as Record<string, unknown>,
  };
}

function failure(err: unknown) {
  const text =
    err instanceof TraqlError
      ? [`traql check failed (${err.code}): ${err.message}`, err.hint].filter(Boolean).join("\n")
      : `traql check failed: ${err instanceof Error ? err.message : String(err)}`;

  return { content: [{ type: "text" as const, text }], isError: true };
}
