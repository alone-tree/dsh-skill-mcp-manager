// Per-tool blacklist smoke test: disabled tools stay visible in the UI view but
// are hidden from model-facing catalogs/load results, are not registered as
// eager native tools, and are rejected at both bridge and stale eager execute
// boundaries. Uses an isolated local stdio MCP server and temp registry.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-tool-disable-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "tool-disable-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "allowed", description: "Allowed tool", inputSchema: { type: "object", additionalProperties: false } },
  { name: "blocked", description: "Blocked tool", inputSchema: { type: "object", additionalProperties: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: "called " + request.params.name }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "demo",
      name: "demo",
      tier: "eager",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [
        { name: "allowed", description: "Allowed tool" },
        { name: "blocked", description: "Blocked tool" },
      ],
      disabledTools: ["blocked"],
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

function activeTool(name) {
  return [...registrations].reverse().find((record) => record.active && record.definition.name === name)?.definition;
}

function activeNativeNames() {
  return registrations
    .filter((record) => record.active && record.definition.name.startsWith("mcp__demo__"))
    .map((record) => record.definition.name)
    .sort();
}

function makeReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
  let index = 0;
  return {
    method: "POST",
    url: "/skill-mcp-manager/mcp/tool-tier",
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

async function setTool(tool, enabled) {
  const route = routes.find((candidate) => candidate.path === "/skill-mcp-manager/mcp/tool-tier");
  if (!route) throw new Error("tool-tier route not registered");
  const res = makeRes();
  await route.handler(makeReq({ name: "demo", tool, enabled }), res);
  const body = res.body ? JSON.parse(res.body) : {};
  if (res.status !== 200) throw new Error(body.error || `tool-tier returned ${res.status}`);
  return body;
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

  const initialNative = activeNativeNames();
  if (initialNative.join(",") !== "mcp__demo__allowed") {
    failed.push(`initial eager tools should only contain allowed, got ${initialNative.join(",")}`);
  }

  const staleAllowed = activeTool("mcp__demo__allowed");
  const mcpRegister = activeTool("mcp_register");
  const mcpLoad = activeTool("mcp_load");
  const mcpCall = activeTool("mcp_call");
  if (!mcpRegister || !mcpLoad || !mcpCall || !staleAllowed) failed.push("required tool definitions missing");

  if (mcpLoad) {
    const peek = await mcpLoad.execute({ name: "demo", peek: true });
    if (!peek.text.includes("allowed")) failed.push("mcp_load peek hid enabled tool");
    if (peek.text.includes("blocked")) failed.push("mcp_load peek exposed disabled tool");
  }

  if (mcpCall) {
    let blockedError = "";
    try {
      await mcpCall.execute({ name: "demo", tool: "blocked", args: {} }, { signal: new AbortController().signal });
    } catch (error) {
      blockedError = String(error?.message ?? error);
    }
    if (!/disabled/.test(blockedError)) failed.push(`mcp_call did not reject disabled tool: ${blockedError}`);
    const allowed = await mcpCall.execute({ name: "demo", tool: "allowed", args: {} }, { signal: new AbortController().signal });
    if (allowed.text !== "called allowed") failed.push(`enabled bridge call failed: ${allowed.text}`);
  }

  const enabledBody = await setTool("blocked", true);
  const enabledView = enabledBody.entry?.tools?.find((tool) => tool.name === "blocked");
  if (enabledView?.enabled !== true) failed.push("UI route did not mark blocked tool enabled");
  if (activeNativeNames().join(",") !== "mcp__demo__allowed,mcp__demo__blocked") {
    failed.push(`enabling did not re-register both eager tools: ${activeNativeNames().join(",")}`);
  }

  const disabledBody = await setTool("allowed", false);
  const disabledView = disabledBody.entry?.tools?.find((tool) => tool.name === "allowed");
  if (disabledView?.enabled !== false) failed.push("UI route did not mark allowed tool disabled");
  if (activeNativeNames().join(",") !== "mcp__demo__blocked") {
    failed.push(`disabling did not remove eager allowed tool: ${activeNativeNames().join(",")}`);
  }

  if (staleAllowed) {
    let staleError = "";
    try {
      await staleAllowed.execute({}, { signal: new AbortController().signal });
    } catch (error) {
      staleError = String(error?.message ?? error);
    }
    if (!/disabled/.test(staleError)) failed.push(`stale eager execute bypassed blacklist: ${staleError}`);
  }

  const result = await preStep(
    { agent: { session: { surface: { nodes: [] }, events: [] } }, signal: { throwIfAborted() {} } },
    async () => ({ kind: "enter", messages: [] }),
  );
  const catalog = JSON.stringify(result.messages);
  if (!catalog.includes("blocked")) failed.push("catalog hid enabled tool after toggle");
  if (catalog.includes("allowed")) failed.push("catalog exposed disabled tool after toggle");

  let registry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  let disabledTools = registry.entries[0]?.disabledTools ?? [];
  if (disabledTools.join(",") !== "allowed") failed.push(`registry blacklist not persisted: ${disabledTools.join(",")}`);

  if (mcpRegister) {
    await mcpRegister.execute({
      name: "demo",
      tier: "eager",
      notes: "updated by model-facing tool",
      disabledTools: [],
    });
    registry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
    disabledTools = registry.entries[0]?.disabledTools ?? [];
    if (disabledTools.join(",") !== "allowed") {
      failed.push(`mcp_register changed the UI-owned blacklist: ${disabledTools.join(",")}`);
    }
    if (activeNativeNames().join(",") !== "mcp__demo__blocked") {
      failed.push(`mcp_register update re-enabled a blacklisted eager tool: ${activeNativeNames().join(",")}`);
    }
  }
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("TOOL DISABLE SMOKE FAILED");
  process.exit(1);
}
console.log("TOOL DISABLE SMOKE PASSED");
