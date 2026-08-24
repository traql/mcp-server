# traql MCP server

[![npm](https://img.shields.io/npm/v/@traql/mcp)](https://www.npmjs.com/package/@traql/mcp)
[![CI](https://github.com/traql/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/traql/mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Glama](https://glama.ai/mcp/servers/traql/mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/traql/mcp-server)

AML and compliance risk scoring for crypto addresses and transactions, exposed to
AI agents over the [Model Context Protocol](https://modelcontextprotocol.io).

Ask your agent *"is it safe to send to this address?"* and it gets back a
0–100 risk score, a band, the risk categories behind it, and — with an API key —
every individual signal with its source and confidence.

```
ethereum address 0x8589427373d6d84e98730d7795d8f6f8731fda16
RISK 100/100 — CRITICAL
Flags: sanctions, mixer, scam

Signals (21):
  +80  [sanctions/eth_labels] direct.sanctions — sanctions label "Tornado.Cash: Donate" [entity Tornado.Cash: Donate, confidence 0.80]
  +68  [mixer/eth_labels] direct.mixer — mixer label "Tornado.Cash: Donate" [entity Tornado.Cash: Donate, confidence 0.80]
  +10  [mixer] behavior.mixer_contact — direct contact with mixer 0xdd4c48c0b24039969fc16d1cdf626eab821d3384
  +9   [sanctions/ofac_sdn] indirect.sanctions — sent to Semenov Roman (sanctions, 18% of USDC volume) [entity Semenov Roman, confidence 1.00]
  ... and 17 more

Computed at 2026-08-23T11:42:49Z.
```

Backed by [traql](https://traql.io): OFAC SDN, UK OFSI, EU and UN sanctions
lists, Tether/Circle freeze events, curated hack and mixer attributions, and
counterparty exposure analysis across **Ethereum, BSC, TRON, TON and Bitcoin**.

## Quick start

Requires Node.js 18+.

```bash
npx -y @traql/mcp
```

The server speaks MCP over stdio, so you normally point a client at it rather
than running it by hand.

### Claude Code

```bash
claude mcp add traql --env TRAQL_API_KEY=your_key -- npx -y @traql/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "traql": {
      "command": "npx",
      "args": ["-y", "@traql/mcp"],
      "env": { "TRAQL_API_KEY": "your_key" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) using the same
`mcpServers` block as above.

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "traql": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@traql/mcp"],
      "env": { "TRAQL_API_KEY": "your_key" }
    }
  }
}
```

## Getting an API key

Sign up at [app.traql.io](https://app.traql.io/signup), confirm your email —
free checks are included — and issue a key under **API keys**. The secret is
shown once; it can be rotated or revoked at any time.

Without a key the server still runs, but on the keyless tier: a single coarse
reason phrase instead of itemized signals, tight rate limits, and on the hosted
API a per-call [x402](https://x402.org) payment requirement. For agent use, set
a key.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TRAQL_API_KEY` | recommended | — | API key from the traql dashboard. Sent as `X-API-Key`. Unlocks itemized signals and higher limits. |
| `TRAQL_API_URL` | no | `https://api.traql.io` | Base URL of the API. Point it at your own deployment if you self-host traql. |
| `TRAQL_TIMEOUT_MS` | no | `30000` | Per-request timeout in milliseconds. |

## Tools

### `check_address`

Scores a single address.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `chain` | `ethereum` \| `bsc` \| `tron` \| `ton` \| `bitcoin` | yes | Network the address belongs to. |
| `address` | string | yes | Address in the chain's native format. |

### `screen_transaction`

Scores both sides of a transfer, in one of two modes:

- **Pre-flight** — pass `from` and `to` (optionally `amount` and `asset`) to
  screen a transfer before broadcasting it. Works on every supported chain.
- **By hash** — pass `tx_hash` alone to look up a transaction that is already
  on-chain. Supported on Ethereum, BSC, TRON and TON.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `chain` | chain enum | yes | Network the transaction belongs to. |
| `from` | string | pre-flight | Sender address. |
| `to` | string | pre-flight | Recipient address. |
| `amount` | string | no | Integer amount in the asset's **base units** (e.g. `1000000` for 1 USDT). |
| `asset` | string | no | Asset or token symbol, e.g. `USDT`. |
| `tx_hash` | string | by-hash | Hash of a broadcast transaction. Mutually exclusive with `from`/`to`. |

### Response

Both tools return human-readable text plus `structuredContent`:

```json
{
  "subject": { "type": "address", "chain": "ethereum", "address": "0x…" },
  "result": {
    "score": 100,
    "band": "critical",
    "flags": ["sanctions", "mixer", "scam"],
    "partial": false,
    "computed_at": "2026-08-23T11:42:49Z",
    "reasons": [
      {
        "code": "direct.sanctions",
        "message": "sanctions label \"Tornado.Cash: Donate\" from eth_labels (severity 100 × confidence 0.80 = 80.0)",
        "contribution": 80,
        "category": "sanctions",
        "source": "eth_labels",
        "entity": "Tornado.Cash: Donate",
        "severity": 100,
        "confidence": 0.8,
        "eff": 80.0
      }
    ]
  }
}
```

Score bands: `clean` 0–9, `low` 10–39, `elevated` 40–69, `high` 70–89,
`critical` 90–100.

`partial: true` means an upstream data source was degraded while computing the
result — read the score as a lower bound, not a final verdict.

Each successful call consumes one check from the configured account. Malformed
input is rejected locally where possible, so it costs nothing.

## Development

```bash
npm install
npm run build
npm test
```

## Notes

Scores are advisory signals for triage and automation. They are not a legal
determination of wrongdoing, and they do not by themselves discharge any
regulatory obligation.

## Links

- [traql.io](https://traql.io) — product
- [API documentation](https://api.traql.io/docs)
- [Dashboard](https://app.traql.io)

## License

MIT
