// Per-session MCP instances: two agents each get their own stdio server
// process; a call in A does not see B's runtime, disposing A does not drop B,
// and UI snapshot refresh does not leave a shared live instance.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-session-isolate-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const id = "pid-" + process.pid + "-" + Math.random().toString(16).slice(2);
const server = new Server({ name: "session-isolate-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "whoami", description: "Return this process id", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: id }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "demo",
      name: "demo",
      tier: "on-demand",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "whoami", description: "Return this process id" }],
      disabledTools: [],
      serverDescription: "test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}, null, 2)}\n`, "utf8");

const registrations = [];
const routes = [];
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
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

function makeAgent() {
  const sessionEffects = [];
  const agent = {
    ctx: {
      tools: {
        register(definition) {
          const record = { definition, active: true, agent };
          registrations.push(record);
          return () => { record.active = false; };
        },
      },
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === "function") sessionEffects.push(disposer);
        return () => {};
      },
    },
    session: { surface: { nodes: [] }, events: [] },
    sessionEffects,
  };
  return agent;
}

function makeReq(path, body) {
  const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
  let index = 0;
  return {
    method: "POST",
    url: path,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return index < chunks.length ? { value: chunks[index++], done: false } : { done: true }; } };
    },
  };
}

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = body ?? ""; };
  return res;
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

  if (routes.some((route) => route.path === "/skill-mcp-manager/mcp/disconnect")) {
    failed.push("disconnect route should be removed");
  }

  const mcpLoad = registrations.find((record) => record.definition.name === "mcp_load")?.definition;
  const mcpCall = registrations.find((record) => record.definition.name === "mcp_call")?.definition;
  if (!mcpLoad || !mcpCall) failed.push("bridge tools missing");

  const agentA = makeAgent();
  const agentB = makeAgent();
  await preStep({ agent: agentA, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));
  await preStep({ agent: agentB, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));

  await mcpLoad.execute({ name: "demo" }, { agent: agentA });
  await mcpLoad.execute({ name: "demo" }, { agent: agentB });
  const idA = (await mcpCall.execute({ name: "demo", tool: "whoami", args: {} }, { signal: new AbortController().signal, agent: agentA })).text;
  const idB = (await mcpCall.execute({ name: "demo", tool: "whoami", args: {} }, { signal: new AbortController().signal, agent: agentB })).text;
  if (!idA || !idB) failed.push("whoami returned empty id");
  if (idA === idB) failed.push(`sessions shared one MCP process: ${idA}`);

  for (const dispose of agentA.sessionEffects.reverse()) await dispose();
  let afterA = "";
  try {
    afterA = (await mcpCall.execute({ name: "demo", tool: "whoami", args: {} }, { signal: new AbortController().signal, agent: agentA })).text;
  } catch (error) {
    afterA = String(error?.message ?? error);
  }
  if (!/not loaded/.test(afterA)) failed.push(`disposing A should drop A's instance: ${afterA}`);
  const stillB = (await mcpCall.execute({ name: "demo", tool: "whoami", args: {} }, { signal: new AbortController().signal, agent: agentB })).text;
  if (stillB !== idB) failed.push(`disposing A affected B: ${stillB}`);

  const loadRoute = routes.find((route) => route.path === "/skill-mcp-manager/mcp/load");
  const res = makeRes();
  await loadRoute.handler(makeReq("/skill-mcp-manager/mcp/load", { name: "demo" }), res);
  const body = res.body ? JSON.parse(res.body) : {};
  if (res.status !== 200 || body.ok !== true) failed.push(`refresh snapshot failed: ${body.error || res.status}`);
  const stillBAfterRefresh = (await mcpCall.execute({ name: "demo", tool: "whoami", args: {} }, { signal: new AbortController().signal, agent: agentB })).text;
  if (stillBAfterRefresh !== idB) failed.push(`snapshot refresh replaced B's instance: ${stillBAfterRefresh}`);
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SESSION ISOLATE SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION ISOLATE SMOKE PASSED");
