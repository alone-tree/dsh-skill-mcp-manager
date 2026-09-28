// Smoke test for lib/stdio-transport.js.
//
// Section 1-2 are pure unit tests over the stream state machine (no child
// process) and run anywhere, including sandboxed environments that forbid
// spawning pipe-backed subprocesses.
//
// Section 3 is a true end-to-end run: it spawns a real MCP server as a child
// process and drives it through the real SDK Client. It requires an
// environment that allows spawning subprocesses with piped stdio (plain
// `node test/stdio-transport-smoke.mjs` in a normal terminal). In a sandbox
// that returns EPERM on spawn the section is skipped with a notice, matching
// e2e-playwright.mjs being outside the release baseline.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResilientStdioTransport, resolveMaxBufferSize } from "../lib/stdio-transport.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. resolveMaxBufferSize ────────────────────────────────────────────────

assert.equal(resolveMaxBufferSize(undefined), STDIO_DEFAULT_MAX_BUFFER_SIZE);
assert.equal(resolveMaxBufferSize(0), STDIO_DEFAULT_MAX_BUFFER_SIZE);
assert.equal(resolveMaxBufferSize(-5), STDIO_DEFAULT_MAX_BUFFER_SIZE);
assert.equal(resolveMaxBufferSize(67108864), 67108864);
console.log("1. resolveMaxBufferSize falls back to the SDK default and passes integers through: OK");

// ── 2. stream state machine (no child process) ────────────────────────────

function makeTransport(limit) {
  const t = new ResilientStdioTransport({ command: "unused", maxBufferSize: limit });
  const seen = { messages: [], errors: [], closes: 0 };
  t.onmessage = (message) => seen.messages.push(message);
  t.onerror = (error) => seen.errors.push(error);
  t.onclose = () => seen.closes++;
  return { t, seen };
}

const LIMIT = 1024;

// A. A complete oversized line in one chunk gets a synthetic error response
//    carrying id, received size and limit; the transport reports no error and
//    no close; the following normal message is delivered aligned.
{
  const { t, seen } = makeTransport(LIMIT);
  const normal = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const oversizedLine = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { pad: "x".repeat(LIMIT + 64) } });
  t._onData(Buffer.from(normal + "\n", "utf8"));
  t._onData(Buffer.from(oversizedLine + "\n", "utf8"));
  assert.equal(seen.errors.length, 0);
  assert.equal(seen.closes, 0);
  assert.equal(seen.messages.length, 2);
  assert.deepEqual(seen.messages[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
  const synthetic = seen.messages[1];
  assert.equal(synthetic.id, 2);
  assert.equal(synthetic.error.code, -32603);
  assert.equal(synthetic.error.data.limit, LIMIT);
  assert.equal(synthetic.error.data.received, Buffer.byteLength(oversizedLine, "utf8"));
  assert.ok(synthetic.error.message.includes("stdioMaxBufferSizeMb"));
  console.log("2a. complete oversized line -> synthetic error with id/size/limit, stream stays open: OK");
}

// B. An oversized message arriving in fragments (no newline yet) is drained,
//    the synthetic error fires once with the exact total size, and messages
//    after the framing newline are delivered normally.
{
  const { t, seen } = makeTransport(LIMIT);
  const oversizedLine = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { pad: "y".repeat(LIMIT * 2) } });
  const lineBuffer = Buffer.from(oversizedLine + "\n", "utf8");
  const after = JSON.stringify({ jsonrpc: "2.0", id: 8, result: { ok: true } });

  // Feed the oversized message in small fragments without a newline.
  const cut = oversizedLine.length; // bytes of the line itself (ASCII JSON)
  const lineBytes = Buffer.from(oversizedLine, "utf8");
  for (let offset = 0; offset + 200 < cut; offset += 200) {
    t._onData(lineBytes.subarray(offset, offset + 200));
  }
  // Framing newline plus the next full message arrive together.
  t._onData(lineBytes.subarray(Math.floor(cut / 200) * 200)); // remainder of the line
  t._onData(Buffer.from("\n" + after + "\n", "utf8"));

  assert.equal(seen.errors.length, 0);
  assert.equal(seen.closes, 0);
  const synthetics = seen.messages.filter((m) => m && m.error);
  const normals = seen.messages.filter((m) => m && !m.error);
  assert.equal(synthetics.length, 1, "exactly one synthetic error");
  assert.equal(synthetics[0].id, 7);
  assert.equal(synthetics[0].error.data.received, cut, "received counts the whole line");
  assert.equal(synthetics[0].error.data.limit, LIMIT);
  assert.deepEqual(normals, [{ jsonrpc: "2.0", id: 8, result: { ok: true } }]);
  console.log("2b. fragmented oversized message -> drained, exact size reported, following message aligned: OK");
}

// C. An oversized notification (has "method", no id) is dropped without a
//    synthetic reply.
{
  const { t, seen } = makeTransport(LIMIT);
  const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { pad: "z".repeat(LIMIT + 16) } });
  t._onData(Buffer.from(note + "\n", "utf8"));
  assert.equal(seen.messages.length, 0);
  assert.equal(seen.errors.length, 0);
  assert.equal(seen.closes, 0);
  console.log("2c. oversized notification -> dropped silently, no synthetic reply: OK");
}

// D. An escaped newline inside a JSON string is not mistaken for the framing
//    newline (JSON.stringify never emits a raw one).
{
  const { t, seen } = makeTransport(LIMIT);
  const tricky = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { text: "line1\\nline2" } });
  t._onData(Buffer.from(tricky + "\n", "utf8"));
  assert.equal(seen.messages.length, 1);
  assert.equal(seen.messages[0].id, 3);
  assert.equal(seen.messages[0].result.text, "line1\\nline2");
  console.log("2d. escaped newline inside JSON string is not a frame boundary: OK");
}

console.log("2. stream state machine: all green");

// ── 3. end-to-end with a real spawned MCP server (skipped under EPERM) ────

const OVERSIZE = 12 * 1024 * 1024; // 12 MB: over the 10 MiB default, under a raised limit

function makeClient(env) {
  const transport = new ResilientStdioTransport({
    command: process.execPath,
    args: [env.__serverPath],
    env: { OVERSIZE_BYTES: env.OVERSIZE_BYTES, __serverPath: undefined, ...(env.maxBufferSize ? {} : {}) },
    maxBufferSize: env.maxBufferSize,
  });
  const client = new Client({ name: "stdio-transport-smoke", version: "0.0.0" });
  return { transport, client };
}

const dir = await mkdtemp(join(tmpdir(), "smx-stdio-"));
const serverPath = join(dir, "oversize-server.mjs");
await writeFile(serverPath, `
import process from "node:process";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: {},
      serverInfo: { name: "oversize-test", version: "0.0.0" },
    } });
    return;
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "boom", description: "returns an oversized response", inputSchema: { type: "object", properties: {} } },
      { name: "echo", description: "returns a small response", inputSchema: { type: "object", properties: {} } },
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.params.name === "boom") {
      const size = Number(process.env.OVERSIZE_BYTES ?? 0);
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "big:" + "x".repeat(size) }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
}
`, "utf8");

async function runE2E() {
  // 3a. default limit: oversized response -> structured error, connection lives.
  {
    const transport = new ResilientStdioTransport({
      command: process.execPath,
      args: [serverPath],
      env: { OVERSIZE_BYTES: String(OVERSIZE) },
    });
    const client = new Client({ name: "stdio-transport-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 2);

      let oversizeError = null;
      try {
        await client.callTool({ name: "boom", arguments: {} });
        assert.fail("oversized call should have failed");
      } catch (error) {
        oversizeError = error;
      }
      const message = String(oversizeError?.message ?? "");
      assert.ok(message.includes("oversized stdio response discarded"), "error names the discard: " + message);
      assert.ok(message.includes(`limit of ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`), "error carries the limit: " + message);
      assert.ok(/received \d+ bytes \(\d+\.\d MB\)/.test(message), "error carries the received size: " + message);

      // The connection must still work: a normal call and a fresh tools/list.
      const echo = await client.callTool({ name: "echo", arguments: {} });
      assert.equal(echo.content[0].text, "ok");
      const toolsAgain = await client.listTools();
      assert.equal(toolsAgain.tools.length, 2);
      console.log("3a. oversized response on default limit -> structured error, connection survives: OK");
    } finally {
      await client.close().catch(() => {});
    }
  }

  // 3b. raised limit: the same oversized response is delivered intact.
  {
    const transport = new ResilientStdioTransport({
      command: process.execPath,
      args: [serverPath],
      env: { OVERSIZE_BYTES: String(OVERSIZE) },
      maxBufferSize: 32 * 1024 * 1024,
    });
    const client = new Client({ name: "stdio-transport-smoke", version: "0.0.0" });
    try {
      assert.equal(transport.maxBufferSize, 32 * 1024 * 1024);
      await client.connect(transport);
      const result = await client.callTool({ name: "boom", arguments: {} });
      const text = result.content[0].text;
      assert.equal(text.length, "big:".length + OVERSIZE);
      console.log("3b. raised maxBufferSize delivers the oversized response intact: OK");
    } finally {
      await client.close().catch(() => {});
    }
  }
}

try {
  await runE2E();
} catch (error) {
  if (error && error.code === "EPERM") {
    console.log("3. end-to-end section SKIPPED: this environment forbids spawning pipe-backed subprocesses (EPERM). Run `node test/stdio-transport-smoke.mjs` in a normal terminal.");
  } else {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

await rm(dir, { recursive: true, force: true });
console.log("stdio-transport-smoke: all green");
