import type { CheckResponse } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.traql.io";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface CheckAddressRequest {
  chain: string;
  address: string;
}

export interface ScreenTransactionRequest {
  chain: string;
  tx_hash?: string;
  from?: string;
  to?: string;
  amount?: string;
  asset?: string;
}

export interface TraqlClientOptions {
  /** Base URL of the traql API. Defaults to the hosted API. */
  baseUrl?: string;
  /** API key sent as `X-API-Key`. Without it the API answers on the keyless tier. */
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Appended to the User-Agent, e.g. the package version. */
  version?: string;
}

/**
 * An error the tool layer can turn into a message the model can act on.
 *
 * `hint` is the actionable part — what the caller (or the human behind it)
 * should do differently. `retryable` marks upstream hiccups that are worth
 * trying again, as opposed to bad input or an exhausted balance.
 */
export class TraqlError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    hint?: string;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = "TraqlError";
    this.code = opts.code;
    this.status = opts.status;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
  }
}

const DASHBOARD = "https://app.traql.io";

/** Thin HTTP client over the two traql scoring endpoints. */
export class TraqlClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: TraqlClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.userAgent = `traql-mcp/${opts.version ?? "0.0.0"}`;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is unavailable — Node.js 18 or newer is required");
    }
  }

  /** True when the client will authenticate; keyless calls get the coarse tier. */
  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  checkAddress(req: CheckAddressRequest): Promise<CheckResponse> {
    return this.post("/v1/check/address", req);
  }

  screenTransaction(req: ScreenTransactionRequest): Promise<CheckResponse> {
    return this.post("/v1/screen/transaction", req);
  }

  private async post(path: string, body: unknown): Promise<CheckResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new TraqlError({
        code: timedOut ? "timeout" : "network_error",
        status: 0,
        message: timedOut
          ? `traql API did not respond within ${this.timeoutMs}ms`
          : `could not reach the traql API at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check network connectivity, or set TRAQL_API_URL if you run a self-hosted deployment.",
        retryable: true,
      });
    }

    const payload = await readJson(res);

    if (res.ok) {
      if (!isCheckResponse(payload)) {
        throw new TraqlError({
          code: "malformed_response",
          status: res.status,
          message: "traql API returned a response without the expected subject/result fields",
          retryable: true,
        });
      }
      return payload;
    }

    throw this.toError(res.status, payload);
  }

  private toError(status: number, payload: unknown): TraqlError {
    // The keyless tier on the hosted API answers 402 with an x402 payment
    // challenge rather than the usual error envelope.
    if (status === 402 && isX402Challenge(payload)) {
      const accept = payload.accepts[0];
      const price = accept ? formatUsdc(accept.maxAmountRequired) : undefined;
      return new TraqlError({
        code: "payment_required",
        status,
        message: price
          ? `the free keyless allowance for this IP is used up; further calls cost ${price} in USDC on ${accept?.network ?? "base"}`
          : "the free keyless allowance for this IP is used up and further calls are payment-gated",
        hint: `Set TRAQL_API_KEY to use an account balance instead — sign up at ${DASHBOARD}/signup for free checks. Paying per call requires an x402-capable wallet, which this server does not carry.`,
      });
    }

    const { code, message } = readErrorEnvelope(payload, status);

    return new TraqlError({
      code,
      status,
      message,
      hint: hintFor(code, status),
      retryable: code === "provider_unavailable" || code === "provider_timeout" || status >= 500,
    });
  }
}

function hintFor(code: string, status: number): string | undefined {
  switch (code) {
    case "unauthorized":
      return `The API key is missing or invalid. Issue one under API keys at ${DASHBOARD}, then set TRAQL_API_KEY.`;
    case "quota_exhausted":
      return `The account has no checks left. Top up the balance at ${DASHBOARD}.`;
    case "rate_limited":
      return "Rate limit exceeded. Wait a moment before retrying.";
    case "daily_cap":
    case "distinct_cap":
      return `Daily cap for this tier reached. An API key raises the limits substantially — see ${DASHBOARD}.`;
    case "invalid_chain":
      return "Supported chains are ethereum, bsc, tron, ton and bitcoin.";
    case "invalid_address":
      return "Check the address matches the format of the chain you selected.";
    case "invalid_tx_hash":
      return "Check the hash is well-formed for this chain. No quota was consumed.";
    case "not_implemented":
      return "Screening by hash is not supported on this chain — pass `from` and `to` instead.";
    case "tx_not_found":
      return "The transaction was not found or is not confirmed yet. Retry later, or screen `from`/`to` directly.";
    case "provider_unavailable":
    case "provider_timeout":
      return "The chain data provider is unavailable. Retry later, or screen `from`/`to` directly.";
    default:
      return status >= 500 ? "An unexpected server error occurred. Retry later." : undefined;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readErrorEnvelope(payload: unknown, status: number): { code: string; message: string } {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "object" &&
    (payload as { error: unknown }).error !== null
  ) {
    const err = (payload as { error: Record<string, unknown> }).error;
    const code = typeof err.code === "string" ? err.code : `http_${status}`;
    const message = typeof err.message === "string" ? err.message : `traql API returned HTTP ${status}`;
    return { code, message };
  }
  return {
    code: `http_${status}`,
    message: typeof payload === "string" && payload ? payload : `traql API returned HTTP ${status}`,
  };
}

interface X402Challenge {
  x402Version: number;
  accepts: Array<{ maxAmountRequired?: string; network?: string; asset?: string }>;
}

function isX402Challenge(payload: unknown): payload is X402Challenge {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "x402Version" in payload &&
    Array.isArray((payload as { accepts?: unknown }).accepts)
  );
}

function isCheckResponse(payload: unknown): payload is CheckResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { subject?: unknown; result?: unknown };
  if (typeof p.subject !== "object" || p.subject === null) return false;
  if (typeof p.result !== "object" || p.result === null) return false;
  return typeof (p.result as { score?: unknown }).score === "number";
}

/** USDC carries 6 decimals, so atomic units divide by 1e6. */
function formatUsdc(atomic: string | undefined): string | undefined {
  if (!atomic || !/^\d+$/.test(atomic)) return undefined;
  const value = Number(atomic) / 1e6;
  return `$${value.toFixed(2)}`;
}
