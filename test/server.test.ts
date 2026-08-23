import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { TraqlClient } from "../src/client.js";
import { buildScreenRequest, createServer } from "../src/server.js";
import type { CheckResponse } from "../src/types.js";

describe("buildScreenRequest", () => {
  it("builds a by-hash request", () => {
    const result = buildScreenRequest({ chain: "tron", tx_hash: "abc" });
    expect(result).toEqual({ value: { chain: "tron", tx_hash: "abc" } });
  });

  it("rejects tx_hash combined with from as ambiguous", () => {
    const result = buildScreenRequest({ chain: "tron", tx_hash: "abc", from: "TFrom" });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("Ambiguous");
  });

  it("rejects by-hash screening on a chain that does not support it", () => {
    const result = buildScreenRequest({ chain: "bitcoin", tx_hash: "abc" });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("not supported");
  });

  it("rejects from without to as missing arguments", () => {
    const result = buildScreenRequest({ chain: "ethereum", from: "0xfrom" });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("Missing arguments");
  });

  it("builds a pre-flight request with amount and asset", () => {
    const result = buildScreenRequest({
      chain: "tron",
      from: "TFrom",
      to: "TTo",
      amount: "1000000000",
      asset: "USDT",
    });
    expect(result).toEqual({
      value: { chain: "tron", from: "TFrom", to: "TTo", amount: "1000000000", asset: "USDT" },
    });
  });

  it("omits amount and asset from the value when not given", () => {
    const result = buildScreenRequest({ chain: "tron", from: "TFrom", to: "TTo" });
    if (!("value" in result)) throw new Error("expected a value, got an error");
    expect("amount" in result.value).toBe(false);
    expect("asset" in result.value).toBe(false);
  });
});

// --- integration: server wired through an in-memory MCP transport ------

function checkResponseBody(): CheckResponse {
  return {
    subject: { type: "address", chain: "ethereum", address: "0x28C6c06298d514Db089934071355E5743bf21d60" },
    result: {
      score: 92,
      band: "critical",
      flags: ["sanctions"],
      partial: false,
      computed_at: "2026-08-23T00:00:00Z",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Connects a fresh server/client pair over an in-memory transport, backed by a fake fetch. */
async function connect(fetchImpl: typeof fetch) {
  const traqlClient = new TraqlClient({ fetchImpl, apiKey: "k", version: "test" });
  const server = createServer(traqlClient, "test");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientTransport);

  return { client, server };
}

describe("createServer (integration)", () => {
  it("lists check_address and screen_transaction, both with an outputSchema", async () => {
    const { client } = await connect(vi.fn());
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["check_address", "screen_transaction"]);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeTruthy();
    }
  });

  it("check_address returns the score in structuredContent and RISK in the text", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(checkResponseBody()));
    const { client } = await connect(fetchImpl);

    const result = await client.callTool({
      name: "check_address",
      arguments: { chain: "ethereum", address: "0x28C6c06298d514Db089934071355E5743bf21d60" },
    });

    expect((result.structuredContent as { result: { score: number } }).result.score).toBe(92);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("RISK");
  });

  it("check_address surfaces an upstream 401 as an error result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "unauthorized", message: "bad key" } }, 401),
    );
    const { client } = await connect(fetchImpl);

    const result = await client.callTool({
      name: "check_address",
      arguments: { chain: "ethereum", address: "0x28C6c06298d514Db089934071355E5743bf21d60" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("unauthorized");
  });

  it("screen_transaction rejects tx_hash on bitcoin locally, without calling fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(checkResponseBody()));
    const { client } = await connect(fetchImpl);

    const result = await client.callTool({
      name: "screen_transaction",
      arguments: { chain: "bitcoin", tx_hash: "abc" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("not supported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid chain at the input-schema level", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(checkResponseBody()));
    const { client } = await connect(fetchImpl);

    // The server validates arguments against the zod input schema before the
    // handler runs and sends back a JSON-RPC error; the SDK client surfaces
    // that as a CallToolResult with isError: true (not a rejected promise).
    const result = await client.callTool({
      name: "check_address",
      arguments: { chain: "polygon", address: "0xabc" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Invalid arguments");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
