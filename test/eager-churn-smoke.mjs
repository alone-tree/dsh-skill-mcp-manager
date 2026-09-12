// Eager registration churn: the pre-step hook runs on EVERY agent step, so an
// unchanged eager entry must NOT dispose + re-register its native tools each
// time (tool-list flap). An entry change (lastSyncAt bump, e.g. setToolEnabled
// / setTier / mcp_register) must re-register. A failed eager connect enters a
// cooldown instead of blocking every step for trialTimeoutMs.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const tmp = join(process.cwd(), `.test-eager-churn-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "eager-churn-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "whoami", description: "identity", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "eagerdemo",
      name: "eagerdemo",
      tier: "eager",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "whoami", description: "identity" }],
      disabledTools: [],
      serverDescription: "test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "deadserver",
      name: "deadserver",
      tier: "eager",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [],
      disabledTools: [],
      serverDescription: "always fails",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}, null, 2)}\n`, "utf8");

const registrations = [];
const disposals = [];
const routes = [];
const effects = [];
let preStep;
const ctx = {
  tools: { register(definition) { registrations.push({ definition, active: true }); return () => { disposals.push(definition.name); }; } },
  skills: { registerProvider() { return () => {}; } },
  on(event, handler) { if (event === "agent/pre-step") preStep = handler; return () => {}; },
  effect(fn) { const disposer = fn(); if (typeof disposer === "function") effects.push(disposer); return () => {}; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

function makeAgent() {
  const sessionEffects = [];
  return {
    ctx: {
      tools: {
        register(definition) {
          registrations.push({ definition, active: true, agentScoped: true });
          return () => { disposals.push(definition.name); };
        },
      },
      effect(fn) { const disposer = fn(); if (typeof disposer === "function") sessionEffects.push(disposer); return () => {}; },
    },
    session: { surface: { nodes: [] }, events: [] },
    sessionEffects,
  };
}

function agentToolRegistrations(agentName) {
  return registrations.filter((record) => record.agentScoped);
}

const failed = [];
try {
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, trialTimeoutMs: 3000 });

  const agent = makeAgent();
  const next = async () => ({ kind: "enter", messages: [] });
  await preStep({ agent, signal: { throwIfAborted() {} } }, next);
  const afterFirst = agentToolRegistrations().length;
  if (afterFirst === 0) failed.push("first step did not register eager tools");
  const disposedAfterFirst = disposals.length;

  // Repeated unchanged steps must not churn registrations.
  await preStep({ agent, signal: { throwIfAborted() {} } }, next);
  await preStep({ agent, signal: { throwIfAborted() {} } }, next);
  if (agentToolRegistrations().length !== afterFirst) failed.push("unchanged steps re-registered eager tools (churn)");
  if (disposals.length !== disposedAfterFirst) failed.push("unchanged steps disposed eager tools (churn)");

  // A dead eager server must not block every step: first step attempts (and
  // fails fast), later steps hit the cooldown instead of reconnecting.
  // (No direct observable; the steps above completing quickly is the guard
  // against a per-step trialTimeoutMs stall.)

  // An entry change (setToolEnabled bumps lastSyncAt) must re-register:
  // disabling the only tool disposes the old registration (and registers
  // zero new ones); re-enabling brings the tool back.
  const tierRoute = routes.find((route) => route.path === "/skill-mcp-manager/mcp/tool-tier");
  if (tierRoute === undefined) failed.push("tool-tier route missing");

  async function callToolTier(enabled) {
    const req = {
      method: "POST",
      url: "/skill-mcp-manager/mcp/tool-tier",
      headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
      [Symbol.asyncIterator]() {
        let done = false;
        return { async next() { if (done) return { done: true }; done = true; return { value: Buffer.from(JSON.stringify({ name: "eagerdemo", tool: "whoami", enabled })), done: false }; } };
      },
    };
    const res = { status: 0, body: "", writeHead(code) { this.status = code; }, end(body) { this.body = body ?? ""; } };
    await tierRoute.handler(req, res);
    return res;
  }

  const disposalsBefore = disposals.length;
  const disableRes = await callToolTier(false);
  if (disableRes.status !== 200) failed.push(`setToolEnabled(disable) failed: ${disableRes.body}`);
  if (disposals.length <= disposalsBefore) failed.push("entry change did not re-register eager tools (no disposal)");

  const enableRes = await callToolTier(true);
  if (enableRes.status !== 200) failed.push(`setToolEnabled(enable) failed: ${enableRes.body}`);
  if (agentToolRegistrations().length <= afterFirst) failed.push("re-enabling did not bring the tool back");
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("EAGER CHURN SMOKE FAILED");
  process.exit(1);
}
console.log("EAGER CHURN SMOKE PASSED");
