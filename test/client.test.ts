import { describe, expect, it, vi } from "vitest";

import { TraqlClient, TraqlError } from "../src/client.js";
import type { CheckResponse } from "../src/types.js";

// --- fixtures ---------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checkResponseBody(): CheckResponse {
  return {
    subject: { type: "address", chain: "ethereum", address: "0xabc" },
    result: {
      score: 92,
      band: "critical",
      flags: ["sanctions"],
      partial: false,
      computed_at: "2026-08-23T00:00:00Z",
    },
  };
}

function errorEnvelope(code: string, message = "boom"): unknown {
  return { error: { code, message } };
}

/** Wraps a Response-returning function as a typed fetch mock, so `.mock.calls` is typed. */
function fetchMock(handler: () => Response | Promise<Response>) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => handler());
}

describe("TraqlClient", () => {
  describe("checkAddress", () => {
    it("posts to /v1/check/address and returns the parsed response", async () => {
      const body = checkResponseBody();
      const fetchImpl = fetchMock(() => jsonResponse(body));
      const client = new TraqlClient({ baseUrl: "https://example.com", fetchImpl });

      const result = await client.checkAddress({ chain: "ethereum", address: "0xabc" });

      expect(result).toEqual(body);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://example.com/v1/check/address");
      expect(init!.method).toBe("POST");
      expect(init!.body).toBe(JSON.stringify({ chain: "ethereum", address: "0xabc" }));
    });
  });

  describe("headers", () => {
    it("sends x-api-key and a versioned user-agent when an apiKey is set", async () => {
      const fetchImpl = fetchMock(() => jsonResponse(checkResponseBody()));
      const client = new TraqlClient({ apiKey: "sk-test", version: "1.2.3", fetchImpl });

      await client.checkAddress({ chain: "ethereum", address: "0xabc" });

      const [, init] = fetchImpl.mock.calls[0]!;
      const headers = init!.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-test");
      expect(headers["user-agent"]).toBe("traql-mcp/1.2.3");
    });

    it("omits x-api-key when no apiKey is configured", async () => {
      const fetchImpl = fetchMock(() => jsonResponse(checkResponseBody()));
      const client = new TraqlClient({ fetchImpl });

      await client.checkAddress({ chain: "ethereum", address: "0xabc" });

      const [, init] = fetchImpl.mock.calls[0]!;
      const headers = init!.headers as Record<string, string>;
      expect("x-api-key" in headers).toBe(false);
    });
  });

  describe("hasApiKey", () => {
    it("is true with an apiKey and false without one", () => {
      const fetchImpl = vi.fn();
      expect(new TraqlClient({ apiKey: "sk-test", fetchImpl }).hasApiKey).toBe(true);
      expect(new TraqlClient({ fetchImpl }).hasApiKey).toBe(false);
    });
  });

  it("does not produce a double slash when baseUrl has a trailing slash", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(checkResponseBody()));
    const client = new TraqlClient({ baseUrl: "https://example.com/", fetchImpl });

    await client.checkAddress({ chain: "ethereum", address: "0xabc" });

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://example.com/v1/check/address");
  });

  it("posts screenTransaction to /v1/screen/transaction", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(checkResponseBody()));
    const client = new TraqlClient({ baseUrl: "https://example.com", fetchImpl });

    await client.screenTransaction({ chain: "tron", tx_hash: "abc" });

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://example.com/v1/screen/transaction");
  });

  describe("error envelopes", () => {
    const cases: Array<{ status: number; code: string }> = [
      { status: 401, code: "unauthorized" },
      { status: 402, code: "quota_exhausted" },
      { status: 429, code: "rate_limited" },
      { status: 400, code: "invalid_address" },
      { status: 501, code: "not_implemented" },
      { status: 404, code: "tx_not_found" },
    ];

    for (const { status, code } of cases) {
      it(`maps HTTP ${status} with code "${code}" to a TraqlError with that code, message and a hint`, async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(errorEnvelope(code, "boom"), status));
        const client = new TraqlClient({ fetchImpl });

        try {
          await client.checkAddress({ chain: "ethereum", address: "0xabc" });
          throw new Error("expected checkAddress to reject");
        } catch (err) {
          expect(err).toBeInstanceOf(TraqlError);
          expect((err as TraqlError).code).toBe(code);
          expect((err as TraqlError).message).toBe("boom");
          expect((err as TraqlError).hint).toBeTruthy();
        }
      });
    }
  });

  describe("retryable", () => {
    it("is true for provider_unavailable (502) and provider_timeout (504)", async () => {
      for (const [status, code] of [
        [502, "provider_unavailable"],
        [504, "provider_timeout"],
      ] as const) {
        const fetchImpl = vi.fn(async () => jsonResponse(errorEnvelope(code), status));
        const client = new TraqlClient({ fetchImpl });
        try {
          await client.checkAddress({ chain: "ethereum", address: "0xabc" });
          throw new Error("expected rejection");
        } catch (err) {
          expect((err as TraqlError).retryable).toBe(true);
        }
      }
    });

    it("is true for any status >= 500 regardless of code", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(errorEnvelope("something_else"), 503));
      const client = new TraqlClient({ fetchImpl });
      try {
        await client.checkAddress({ chain: "ethereum", address: "0xabc" });
        throw new Error("expected rejection");
      } catch (err) {
        expect((err as TraqlError).retryable).toBe(true);
      }
    });

    it("is false for 400/401/402/429", async () => {
      for (const [status, code] of [
        [400, "invalid_address"],
        [401, "unauthorized"],
        [402, "quota_exhausted"],
        [429, "rate_limited"],
      ] as const) {
        const fetchImpl = vi.fn(async () => jsonResponse(errorEnvelope(code), status));
        const client = new TraqlClient({ fetchImpl });
        try {
          await client.checkAddress({ chain: "ethereum", address: "0xabc" });
          throw new Error("expected rejection");
        } catch (err) {
          expect((err as TraqlError).retryable).toBe(false);
        }
      }
    });
  });

  it("maps the x402 payment-challenge envelope to a payment_required TraqlError", async () => {
    const x402Body = {
      x402Version: 1,
      error: "payment required",
      accepts: [{ maxAmountRequired: "500000", network: "base" }],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(x402Body, 402));
    const client = new TraqlClient({ fetchImpl });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TraqlError);
      const traqlErr = err as TraqlError;
      expect(traqlErr.code).toBe("payment_required");
      expect(traqlErr.message).toContain("$0.50");
      expect(traqlErr.hint).toContain("TRAQL_API_KEY");
    }
  });

  it("treats a 200 response without a result field as malformed_response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new TraqlClient({ fetchImpl });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as TraqlError).code).toBe("malformed_response");
    }
  });

  it("treats a 200 response with invalid JSON as malformed_response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = new TraqlClient({ fetchImpl });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as TraqlError).code).toBe("malformed_response");
    }
  });

  it("maps a network failure to a retryable network_error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const client = new TraqlClient({ fetchImpl });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as TraqlError).code).toBe("network_error");
      expect((err as TraqlError).retryable).toBe(true);
    }
  });

  it("maps a TimeoutError to a retryable timeout mentioning the configured timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const client = new TraqlClient({ fetchImpl, timeoutMs: 5000 });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as TraqlError).code).toBe("timeout");
      expect((err as TraqlError).retryable).toBe(true);
      expect((err as TraqlError).message).toContain("5000");
    }
  });

  it("falls back to http_<status> when the error body has no envelope", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 500, headers: { "content-type": "application/json" } }),
    );
    const client = new TraqlClient({ fetchImpl });

    try {
      await client.checkAddress({ chain: "ethereum", address: "0xabc" });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as TraqlError).code).toBe("http_500");
    }
  });
});
