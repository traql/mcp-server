#!/usr/bin/env node
import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, TraqlClient } from "./client.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `traql-mcp ${version} — MCP server for traql AML risk scoring

Speaks the Model Context Protocol over stdio; run it from an MCP client
rather than directly.

Environment:
  TRAQL_API_KEY     API key from https://app.traql.io. Without it the server
                    falls back to the keyless tier: a coarse verdict, 3 free
                    checks per day, then payment-gated on the hosted API.
  TRAQL_API_URL     Base URL of the API. Defaults to ${DEFAULT_BASE_URL}.
                    Point it at your own deployment if you self-host.
  TRAQL_TIMEOUT_MS  Per-request timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.

Options:
  -h, --help        Show this message.
  -v, --version     Print the version.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const client = new TraqlClient({
    baseUrl: process.env.TRAQL_API_URL,
    apiKey: process.env.TRAQL_API_KEY,
    timeoutMs: parseTimeout(process.env.TRAQL_TIMEOUT_MS),
    version,
  });

  if (!client.hasApiKey) {
    // stderr only: stdout carries the protocol stream.
    console.error(
      "traql-mcp: TRAQL_API_KEY is not set — running on the keyless tier. The hosted API allows 3 free checks a day from your IP and returns a coarse verdict without itemized reasons; beyond that it asks for payment. Get a key at https://app.traql.io.",
    );
  }

  const server = createServer(client, version);
  await server.connect(new StdioServerTransport());
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`traql-mcp: ignoring invalid TRAQL_TIMEOUT_MS=${raw}`);
    return undefined;
  }
  return parsed;
}

main().catch((err: unknown) => {
  console.error(`traql-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
