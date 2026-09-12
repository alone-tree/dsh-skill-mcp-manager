// mcp_call parameter-shape guard + tool-call error context smoke test.
// Verifies that:
//   1. well-shaped bridge calls still succeed (incl. omitted args for no-arg tools);
//   2. nested/malformed mcp_call parameters are rejected early with the correct
//      shape spelled out (never auto-unwrapped) instead of reaching the server
//      as params.name=undefined and dying as an opaque -32602;
//   3. protocol-level tool-call failures (server-side JSON-RPC errors) carry
//      the call context (server/tool, arguments sent, inputSchema) on both the
//      on-demand bridge and the eager native execute path.
// Uses an isolated local stdio MCP server and a temp registry.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-mcp-call-guard-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";
const server = new Server({ name: "call-guard-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
  { name: "noargs", description: "No-arg tool", inputSchema: { type: "object", additionalProperties: false } },
  { name: "fail", description: "Always fails server-side", inputSchema: { type: "object", additionalProperties: false } },
  { name: "softfail", description: "Returns an isError result", inputSchema: { type: "object", additionalProperties: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fail") throw new Error("boom-intentional");
  if (request.params.name === "softfail") {
    return { content: [{ type: "text", text: "soft failure: bad thing happened" }], isError: true };
  }
  return { content: [{ type: "text", text: "called " + request.params.name + " " + JSON.stringify(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
`, "utf8");

function entry(id, tier) {
  return {
    id,
    name: id,
    tier,
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
    env: {},
    cwd: process.cwd(),
    notes: "",
    tools: [
      { name: "echo", description: "Echo tool" },
      { name: "noargs", description: "No-arg tool" },
      { name: "fail", description: "Always fails server-side" },
      { name: "softfail", description: "Returns an isError result" },
    ],
    serverDescription: "test server",
    metaFetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [entry("demo", "on-demand"), entry("eagerdemo", "eager")],
}, null, 2)}\n`, "utf8");

const registrations = [];
const effects = [];
let preStep;
const ctx = {
  tools: {
    register(definition) {
      const record = { definition, active: true };
      registrations.push(record);
      return () => { record.active = false; };
    },
  },
  skills: { registerProvider() { return () => {}; } },
  on(event, handler) {
    if (event === "agent/pre-step") preStep = handler;
    return () => {};
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === "function") effects.push(disposer);
    return () => {};
  },
  get() {
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

function activeTool(name) {
  return [...registrations].reverse().find((record) => record.active && record.definition.name === name)?.definition;
}

function makeAgent() {
  return {
    ctx: {
      tools: ctx.tools,
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === "function") effects.push(disposer);
        return () => {};
      },
    },
    session: { surface: { nodes: [] }, events: [] },
  };
}

async function expectError(promise, patterns, label) {
  try {
    await promise;
    return `${label}: expected rejection but resolved`;
  } catch (error) {
    const message = String(error?.message ?? error);
    for (const pattern of patterns) {
      if (!pattern.test(message)) return `${label}: error message missing ${pattern} — got: ${JSON.stringify(message)}`;
    }
    return null;
  }
}

const exec = (agent) => ({ signal: new AbortController().signal, agent });
const failed = [];
try {
  await apply(ctx, {
    dataDir,
    profile: "__test__",
    importNativeMcp: false,
    trialTimeoutMs: 5000,
    toolCallTimeoutMs: 5000,
  });

  const agent = makeAgent();
  await preStep(
    { agent, signal: { throwIfAborted() {} } },
    async () => ({ kind: "enter", messages: [] }),
  );

  const mcpLoad = activeTool("mcp_load");
  const mcpCall = activeTool("mcp_call");
  if (!mcpLoad || !mcpCall) { failed.push("mcp_load/mcp_call definitions missing"); }
  else {
    await mcpLoad.execute({ name: "demo" }, exec(agent));

    // 1. well-shaped calls still work
    const echoed = await mcpCall.execute({ name: "demo", tool: "echo", args: { msg: "hi" } }, exec(agent));
    if (!echoed.text.includes("called echo") || !echoed.text.includes("hi")) {
      failed.push(`well-shaped bridge call regressed: ${echoed.text}`);
    }
    const noargs = await mcpCall.execute({ name: "demo", tool: "noargs" }, exec(agent));
    if (!noargs.text.includes("called noargs")) {
      failed.push(`omitted-args bridge call regressed: ${noargs.text}`);
    }

    // 2. malformed shapes are rejected with the correct shape, no auto-unwrap
    failed.push(await expectError(
      mcpCall.execute({ name: "demo", args: { tool: "echo", args: { msg: "hi" } } }, exec(agent)),
      [/nested inside "args"/, /TOP-LEVEL/],
      "nested shape",
    ));
    failed.push(await expectError(
      mcpCall.execute({ name: "demo" }, exec(agent)),
      [/requires a top-level "tool" string field/],
      "missing tool",
    ));
    failed.push(await expectError(
      mcpCall.execute({ name: "demo", tool: "echo", args: "oops" }, exec(agent)),
      [/"args" must be an object/],
      "non-object args",
    ));

    // 3a. bridge path: server-side JSON-RPC failure carries call context
    failed.push(await expectError(
      mcpCall.execute({ name: "demo", tool: "fail", args: { x: 1 } }, exec(agent)),
      [/called MCP tool: demo\/fail/, /arguments sent: \{"x":1\}/, /tool inputSchema: \{/],
      "bridge error context",
    ));

    // 3a'. bridge path: isError tool results (business failures) carry the same context
    failed.push(await expectError(
      mcpCall.execute({ name: "demo", tool: "softfail", args: { q: 9 } }, exec(agent)),
      [/soft failure: bad thing happened/, /called MCP tool: demo\/softfail/, /arguments sent: \{"q":9\}/],
      "bridge isError context",
    ));
  }

  // 3b. eager path: same context on the native execute boundary
  const eagerFail = activeTool("mcp__eagerdemo__fail");
  if (!eagerFail) failed.push("eager fail tool not registered");
  else {
    failed.push(await expectError(
      eagerFail.execute({ y: 2 }, exec(agent)),
      [/called MCP tool: eagerdemo\/fail/, /arguments sent: \{"y":2\}/, /tool inputSchema: \{/],
      "eager error context",
    ));
    const eagerEcho = activeTool("mcp__eagerdemo__echo");
    const ok = await eagerEcho.execute({ msg: "hey" }, exec(agent));
    if (!ok.text.includes("called echo")) failed.push(`eager echo regressed: ${ok.text}`);

    // 3b'. eager path: isError tool results carry the same context
    const eagerSoftfail = activeTool("mcp__eagerdemo__softfail");
    if (!eagerSoftfail) failed.push("eager softfail tool not registered");
    else {
      failed.push(await expectError(
        eagerSoftfail.execute({ z: 3 }, exec(agent)),
        [/soft failure: bad thing happened/, /called MCP tool: eagerdemo\/softfail/, /arguments sent: \{"z":3\}/],
        "eager isError context",
      ));
    }
  }
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

const realFailures = failed.filter((item) => item !== null);
if (realFailures.length > 0) {
  for (const item of realFailures) console.log("FAIL:", item);
  console.log("MCP CALL GUARD SMOKE FAILED");
  process.exit(1);
}
console.log("MCP CALL GUARD SMOKE PASSED");
