#!/usr/bin/env node
/**
 * Starts the built server, speaks MCP to it over stdio and checks that both
 * tools are advertised.
 *
 * The unit tests need Node 20+ (vitest), while the package supports Node 18,
 * so this script is what keeps the lower bound honest: it uses nothing but the
 * standard library and exercises the real entrypoint.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(root, "dist", "index.js");

const EXPECTED_TOOLS = ["check_address", "screen_transaction"];
const TIMEOUT_MS = 20_000;

const child = spawn(process.execPath, [entrypoint], {
  stdio: ["pipe", "pipe", "pipe"],
  // Keep the run hermetic: no key, no outbound calls.
  env: { ...process.env, TRAQL_API_KEY: "" },
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timer = setTimeout(() => {
  fail(`server did not answer within ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);

function fail(message) {
  clearTimeout(timer);
  child.kill("SIGKILL");
  console.error(`smoke: FAIL — ${message}`);
  if (stderr.trim()) console.error(`smoke: server stderr:\n${stderr.trim()}`);
  process.exit(1);
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

child.on("error", (err) => fail(`could not start the server: ${err.message}`));

child.on("exit", (code) => {
  if (code !== 0 && code !== null) fail(`server exited with code ${code}`);
});

child.stdout.on("data", () => {
  const response = findResponse(stdout, 2);
  if (!response) return;

  clearTimeout(timer);

  const tools = response.result?.tools;
  if (!Array.isArray(tools)) {
    fail(`tools/list returned no tools array: ${JSON.stringify(response).slice(0, 300)}`);
    return;
  }

  const names = tools.map((tool) => tool.name).sort();
  if (names.join(",") !== EXPECTED_TOOLS.join(",")) {
    fail(`expected tools ${EXPECTED_TOOLS.join(", ")} but got ${names.join(", ") || "none"}`);
    return;
  }

  for (const tool of tools) {
    if (!tool.inputSchema || !tool.outputSchema) {
      fail(`tool ${tool.name} is missing an input or output schema`);
      return;
    }
  }

  console.log(`smoke: OK — ${names.join(", ")} advertised with schemas on Node ${process.version}`);
  child.kill("SIGTERM");
  process.exit(0);
});

function findResponse(buffer, id) {
  for (const line of buffer.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === id) return parsed;
    } catch {
      // Partial line; the next chunk will complete it.
    }
  }
  return undefined;
}
