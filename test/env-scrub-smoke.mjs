// Env scrub + `$VAR` expansion: a spawned stdio MCP server must receive the
// host's SCRUBBED parent env (credential-shaped names and DSH_* dropped, the
// same rule as the native dsh-mcp-client), explicit entry env always wins
// over the scrubbed parent value, and a `$VAR` reference is expanded from the
// host environment at spawn time (the README contract) instead of being
// passed through as a literal.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const tmp = join(process.cwd(), `.test-env-scrub-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

// Parent-env probes: one credential-shaped name (must be scrubbed), one
// DSH_-prefixed name (must be scrubbed), one plain name (must be inherited).
process.env.SMCMM_FAKE_API_KEY = "parent-secret-must-not-leak";
process.env.DSH_STALE_LEAK = "dsh-must-not-leak";
process.env.SMCMM_PLAIN_PARENT = "plain-parent-ok";

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "env-scrub-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "env_probe", description: "Echo selected env values", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: JSON.stringify({
    ref: process.env.SMCMM_TEST_REF ?? null,
    explicit: process.env.SMCMM_EXPLICIT ?? null,
    pathOverride: process.env.PATH ?? null,
    parentKey: process.env.SMCMM_FAKE_API_KEY ?? null,
    dshLeak: process.env.DSH_STALE_LEAK ?? null,
    plainParent: process.env.SMCMM_PLAIN_PARENT ?? null,
    unsetRef: process.env.SMCMM_UNSET_REF ?? null,
  }) }],
}));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "envdemo",
      name: "envdemo",
      tier: "on-demand",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {
        SMCMM_TEST_REF: "$SMCMM_REF_SECRET",
        SMCMM_UNSET_REF: "$SMCMM_DEFINITELY_UNSET_VAR",
        SMCMM_EXPLICIT: "explicit-literal",
        PATH: "overridden-path",
      },
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "env_probe", description: "Echo selected env values" }],
      disabledTools: [],
      serverDescription: "test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}, null, 2)}\n`, "utf8");

process.env.SMCMM_REF_SECRET = "expanded-ref-secret";

const registrations = [];
const effects = [];
const ctx = {
  tools: { register(definition) { registrations.push(definition); return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect(fn) { const disposer = fn(); if (typeof disposer === "function") effects.push(disposer); return () => {}; },
  get() { return undefined; },
  logger: { warn() {}, error() {}, info() {} },
};

const failed = [];
try {
  await apply(ctx, {
    dataDir,
    profile: "__test__",
    importNativeMcp: false,
    trialTimeoutMs: 10000,
    toolCallTimeoutMs: 10000,
  });
  const mcpLoad = registrations.find((t) => t.name === "mcp_load");
  const mcpCall = registrations.find((t) => t.name === "mcp_call");
  if (!mcpLoad || !mcpCall) failed.push("bridge tools missing");

  const agent = {
    ctx: {
      tools: { register() { return () => {}; } },
      effect(fn) { const disposer = fn(); if (typeof disposer === "function") effects.push(disposer); return () => {}; },
    },
    session: { surface: { nodes: [] }, events: [] },
  };
  await mcpLoad.execute({ name: "envdemo" }, { agent });
  const text = (await mcpCall.execute({ name: "envdemo", tool: "env_probe", args: {} }, { signal: new AbortController().signal, agent })).text;
  const env = JSON.parse(text);

  if (env.ref !== "expanded-ref-secret") failed.push(`$VAR reference was not expanded: ${JSON.stringify(env.ref)}`);
  if (env.unsetRef !== "") failed.push(`unset $VAR reference should expand to "": ${JSON.stringify(env.unsetRef)}`);
  if (env.explicit !== "explicit-literal") failed.push(`explicit env value lost: ${JSON.stringify(env.explicit)}`);
  if (env.pathOverride !== "overridden-path") failed.push(`explicit env must win over the scrubbed parent value: ${JSON.stringify(env.pathOverride)}`);
  if (env.parentKey !== null) failed.push("credential-shaped parent env var leaked into the MCP server");
  if (env.dshLeak !== null) failed.push("DSH_* parent env var leaked into the MCP server");
  if (env.plainParent !== "plain-parent-ok") failed.push("plain parent env var was not inherited");
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("ENV SCRUB SMOKE FAILED");
  process.exit(1);
}
console.log("ENV SCRUB SMOKE PASSED");
