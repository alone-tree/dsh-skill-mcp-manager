// End-to-end test against a real MCP server (Playwright MCP, stdio/npx).
// Exercises the three model-facing tools deterministically: mcp_register
// (trial-connect + listTools), mcp_load (reload + definitions), mcp_call
// (invoke one tool through the bridge).

import { apply } from "../lib/index.js";

const registered = {};
let cleanup = null;

const ctx = {
  tools: {
    register(def) {
      registered[def.name] = def;
      return () => {};
    },
  },
  on() {
    return () => {};
  },
  effect(fn) {
    const disposer = fn();
    cleanup = async () => {
      if (typeof disposer === "function") await disposer();
    };
    return () => {};
  },
  logger: {
    info: (...a) => console.log("[info]", ...a),
    warn: (...a) => console.log("[warn]", ...a),
    error: (...a) => console.log("[error]", ...a),
  },
};

await apply(ctx, {
  dataDir: "D:/Github/dsh-skill-mcp-manager/.test-data/e2e",
  profile: "web",
  trialTimeoutMs: 120000,
  toolCallTimeoutMs: 120000,
});

const pw = {
  name: "playwright",
  description: "Browser automation via Playwright MCP",
  tier: "on-demand",
  transport: "stdio",
  command: "C:\\Program Files\\nodejs\\npx.cmd",
  args: ["-y", "@playwright/mcp@latest"],
};

const exec = { signal: new AbortController().signal };
let failed = false;

console.log("\n=== 1) mcp_register ===");
try {
  const res = await registered.mcp_register.execute(pw);
  console.log(res.text);
} catch (error) {
  failed = true;
  console.log("REGISTER FAILED:", error?.message ?? error);
}

if (!failed) {
  console.log("\n=== 2) mcp_load ===");
  try {
    const res = await registered.mcp_load.execute({ name: "playwright" });
    console.log(res.text.slice(0, 2000));
  } catch (error) {
    failed = true;
    console.log("LOAD FAILED:", error?.message ?? error);
  }
}

if (!failed) {
  console.log("\n=== 3) mcp_call (browser_navigate to example.com) ===");
  try {
    const res = await registered.mcp_call.execute(
      { name: "playwright", tool: "browser_navigate", args: { url: "https://example.com" } },
      exec,
    );
    console.log(res.text.slice(0, 1000));
  } catch (error) {
    // A browser-not-installed error is still a clean bridge round-trip.
    failed = true;
    console.log("CALL ERROR:", error?.message?.slice(0, 500) ?? error);
  }
}

// Dispose: close the live on-demand connection so the process can exit.
if (cleanup) await cleanup();

console.log(failed ? "\nE2E TEST FAILED" : "\nE2E TEST PASSED");
process.exit(failed ? 1 : 0);
