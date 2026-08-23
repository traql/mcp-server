# Publishing checklist

Internal notes for cutting a release and keeping directory listings current.

## 1. npm

The package is scoped, so the npm organisation must exist and the first publish
needs explicit public access.

The `traql` organisation has to be created once at
<https://www.npmjs.com/org/create> — npm has no CLI command for it. The free
plan covers unlimited public packages.

```bash
npm login
npm publish --access public   # subsequent releases go through the tag workflow
```

Scoped packages default to restricted access, hence `--access public` on the
first publish.

## 2. MCP Registry

The server namespace is `io.traql`, which requires DNS authentication — GitHub
auth would only grant `io.github.traql`.

Generate the key pair (macOS ships LibreSSL, which cannot do Ed25519, so use
OpenSSL 3 explicitly):

```bash
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl   # Apple Silicon
$OPENSSL genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "traql.io. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

Add that TXT record at the **apex** of `traql.io` — not under a selector such
as `_mcp-auth`. Wait for propagation, then:

```bash
brew install mcp-publisher
PRIVATE_KEY="$($OPENSSL pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain traql.io --private-key "$PRIVATE_KEY"
mcp-publisher publish
```

Store `PRIVATE_KEY` as the `MCP_DNS_PRIVATE_KEY` repository secret so the
publish workflow can do this on tag pushes. `key.pem` is gitignored — keep it
out of the repo.

Requirements the registry enforces:

- `package.json` must carry `mcpName` matching `server.json` `name`.
- The npm package must already be published when the registry publish runs.
- `server.json` `description` is capped at 100 characters.

## 3. Directories

Most aggregators ingest the official registry, but several need their own
submission.

| Directory | How | Notes |
| --- | --- | --- |
| MCP Registry | `mcp-publisher publish` | Feeds VS Code gallery, mcp.so and others |
| Glama | https://glama.ai/mcp/servers — submit repo URL | Scores repo quality: README, license, tests, CI |
| Smithery | https://smithery.ai/new — connect GitHub repo | Wants `smithery.yaml` for hosted runs |
| PulseMCP | https://www.pulsemcp.com/submit | Manual review |
| mcp.so | https://mcp.so/submit | Often auto-ingests from the registry |
| Cursor Directory | https://cursor.directory/mcp — submit | |
| awesome-mcp-servers | PR to https://github.com/punkpeye/awesome-mcp-servers | One line under the finance/crypto section |

Suggested one-liner for submissions:

> **traql** — AML risk scoring for crypto addresses and transactions. Screens
> against OFAC, UK, EU and UN sanctions lists, issuer freeze events, mixers and
> known hacks across Ethereum, BSC, TRON, TON and Bitcoin, returning a 0–100
> score with itemized, sourced reasons.

## 4. Release

```bash
npm version patch|minor|major     # updates package.json
# bump the two version fields in server.json to match
git push --follow-tags            # the tag triggers .github/workflows/publish.yml
```

CI fails the release if `server.json` and `package.json` disagree.
