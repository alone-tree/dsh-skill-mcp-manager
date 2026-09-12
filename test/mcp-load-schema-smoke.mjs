// mcp_load schema smoke test: tool snapshots (registry entry.tools, written by
// snapshotTools on load/refresh and ensureEager on eager mount) must keep the
// server-declared inputSchema, and the text mcp_load returns on BOTH the load
// and peek paths must render it — otherwise the model cannot see parameter
// structure before calling and can only guess against validation errors.
// Uses an isolated local stdio MCP server and temp registry.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-mcp-load-schema-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const widgetSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "read"] },
    table_edit: {
      type: "object",
      properties: { row: { type: "integer" }, values: { type: "array", items: { type: "string" } } },
      required: ["row"],
    },
  },
  required: ["action"],
};

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";
const server = new Server({ name: "load-schema-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "widget", description: "Multi-action widget", inputSchema: ${JSON.stringify(widgetSchema)} },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: "called " + request.params.name }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

// Seed entries with the pre-1.1.3 snapshot shape (name + description only, no
// inputSchema) and a non-empty metaFetchedAt so startup warm-up skips them;
// the test then exercises the load path refreshing the stale shape.
await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "bridge",
      name: "bridge",
      tier: "on-demand",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "widget", description: "Multi-action widget" }],
      disabledTools: [],
      serverDescription: "schema test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "direct",
      name: "direct",
      tier: "eager",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "widget", description: "Multi-action widget" }],
      disabledTools: [],
      serverDescription: "schema test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
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
  get() { return undefined; },
  logger: { warn() {}, error() {}, info() {} },
};

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

  const mcpLoad = [...registrations].reverse().find((record) => record.active && record.definition.name === "mcp_load")?.definition;
  if (!mcpLoad) {
    failed.push("mcp_load definition missing");
  } else {
    // 1) Non-peek load: connects, refreshes the snapshot, and must render the
    //    schema inline (compact JSON, so nested required arrays appear verbatim).
    const loaded = await mcpLoad.execute({ name: "bridge" }, { signal: new AbortController().signal, agent });
    for (const needle of ["inputSchema", "table_edit", '"required":["row"]', '"required":["action"]']) {
      if (!loaded.text.includes(needle)) failed.push(`mcp_load result missing ${needle}`);
    }

    // 2) Persisted snapshot: registry.json entry.tools must carry inputSchema.
    const registry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
    const bridgeTools = registry.entries.find((entry) => entry.name === "bridge")?.tools ?? [];
    const widget = bridgeTools.find((tool) => tool.name === "widget");
    if (!widget?.inputSchema || widget.inputSchema.required?.join(",") !== "action") {
      failed.push(`registry snapshot lost inputSchema: ${JSON.stringify(widget)}`);
    }

    // 3) Peek without a live connection: falls back to the persisted snapshot
    //    (no exec -> no session) and must still render the schema.
    const peek = await mcpLoad.execute({ name: "bridge", peek: true });
    for (const needle of ["inputSchema", '"required":["row"]']) {
      if (!peek.text.includes(needle)) failed.push(`mcp_load peek missing ${needle}`);
    }

    // 4) Eager mount path (ensureEager) must keep the same snapshot shape.
    const eagerAgent = makeAgent();
    await preStep(
      { agent: eagerAgent, signal: { throwIfAborted() {} } },
      async () => ({ kind: "enter", messages: [] }),
    );
    const eagerPeek = await mcpLoad.execute({ name: "direct", peek: true });
    if (!eagerPeek.text.includes("inputSchema")) failed.push("eager snapshot lost inputSchema");
  }
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("MCP LOAD SCHEMA SMOKE FAILED");
  process.exit(1);
}
console.log("MCP LOAD SCHEMA SMOKE PASSED");
