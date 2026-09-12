// Minimal smoke test: load the plugin module against a mock ctx and verify
// apply() registers the three model-facing tools and the pre-step listener
// without throwing. No real MCP server or live DSH is required.

import { apply, name, inject } from "../lib/index.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const registered = [];
const listeners = new Map();
const commands = [];
let cleanup = null;

const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  skills: {
    registerProvider() {
      return () => {};
    },
  },
  on(event, handler) {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  effect(fn) {
    const disposer = fn();
    cleanup = () => {
      if (typeof disposer === "function") void disposer();
    };
    return () => {};
  },
  get(name) {
    if (name === "commands") {
      return {
        register(definition) {
          commands.push(definition);
          return () => {};
        },
      };
    }
    return undefined;
  },
  logger: {
    warn: (...args) => console.log("[warn]", ...args),
    error: (...args) => console.log("[error]", ...args),
    info: (...args) => console.log("[info]", ...args),
  },
};

console.log("name:", name);
console.log("inject:", inject.join(","));

await apply(ctx, {
  dataDir: ".test-data",
  profile: "__test__",
  importNativeMcp: false,
  trialTimeoutMs: 3000,
  toolCallTimeoutMs: 3000,
});

// Let async startup (loadRegistry + reconcile) settle.
await new Promise((resolve) => setTimeout(resolve, 100));

const toolNames = registered.map((t) => t.name);
console.log("registered tools:", toolNames.join(", "));

const expected = ["mcp_register", "mcp_load", "mcp_call"];
let failed = false;
for (const name of expected) {
  if (!toolNames.includes(name)) {
    console.log(`FAIL: missing tool ${name}`);
    failed = true;
  }
}
for (const tool of registered) {
  if (typeof tool.description !== "string" || !tool.parameters || typeof tool.output?.render !== "function" || typeof tool.execute !== "function") {
    console.log(`FAIL: tool ${tool.name} has an invalid definition shape`);
    failed = true;
  }
}
if (!listeners.has("agent/pre-step")) {
  console.log("FAIL: missing agent/pre-step listener");
  failed = true;
}
if (!commands.some((c) => c.name === "prepare-uninstall")) {
  console.log("FAIL: missing prepare-uninstall command");
  failed = true;
}

if (typeof cleanup === "function") cleanup();

if (failed) {
  console.log("SMOKE TEST FAILED");
  process.exit(1);
}
console.log("SMOKE TEST PASSED");
