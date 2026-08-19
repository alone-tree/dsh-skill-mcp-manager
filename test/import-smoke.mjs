// Import/takeover smoke test: boot the plugin against a temp DSH_HOME whose
// profile patch holds native @deepseek-ai/dsh-mcp-client rows, and verify it
// (1) imports them into the registry (on-demand, or disabled when the native
// row is disabled), (2) appends an id-targeted `disabled: true` takeover row
// for each enabled native row, and (3) leaves the native section byte-for-byte
// intact.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const tmp = join(homedir(), ".dsh-import-smoke-" + process.pid);
const dataDir = join(tmp, "data");
const profileDir = join(tmp, "profiles", "test");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(profileDir, { recursive: true });

const nativePatch = [
  "# test native section — must survive byte-for-byte",
  "- insert:",
  "    - id: mcp-tavily",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: tavily",
  "        transport: streamable-http",
  "        url: 'https://mcp.tavily.com/mcp/'",
  "    - id: mcp-off",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: off-server",
  "        transport: stdio",
  "        command: node",
  "        args: ['-e', '']",
  "      disabled: true",
].join("\n") + "\n";
await writeFile(join(profileDir, "cordis.patch.yml"), nativePatch, "utf8");

// Set DSH_HOME BEFORE the module is imported so the module-level constant
// resolves to the temp home.
process.env.DSH_HOME = tmp;
const { apply } = await import("../lib/index.js");

const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect() { return () => {}; },
  get(name) {
    if (name === "commands") return { register() { return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 100));

const failed = [];

// 1. registry: tavily imported as on-demand, off-server as disabled.
const registry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
const byName = new Map(registry.entries.map((e) => [e.name, e]));
console.log("registry entries:", registry.entries.map((e) => `${e.name}[${e.tier}]`).join(", "));
if (byName.get("tavily")?.tier !== "on-demand") failed.push("tavily should import as on-demand");
if (byName.get("tavily")?.transport !== "streamable-http") failed.push("tavily transport not mapped");
if (byName.get("tavily")?.systemEntryId !== "mcp-tavily") failed.push("tavily systemEntryId not mapped");
if (byName.get("off-server")?.tier !== "disabled") failed.push("off-server should import as disabled (native disabled)");

// 2. patch: native section preserved, takeover row present for the enabled row only.
const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- resulting patch ----\n" + patch);
if (!patch.includes("# test native section — must survive byte-for-byte")) failed.push("native comment lost");
if (!patch.includes("- id: mcp-tavily\n  disabled: true")) failed.push("missing takeover row for mcp-tavily");
if (patch.includes("- id: mcp-off\n  disabled: true")) failed.push("takeover row written for an already-disabled native row");
if (!patch.includes("Managed MCP servers")) failed.push("managed marker missing");

// 3. No shadow insert for native entries (their native row is the mirror).
const shadowInsertCount = (patch.match(/name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/g) || []).length;
// native rows keep 2 occurrences (the two insert rows); no extra shadow rows added.
if (shadowInsertCount !== 2) failed.push(`expected 2 dsh-mcp-client rows (native only), got ${shadowInsertCount}`);

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  console.log("IMPORT SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("IMPORT SMOKE TEST PASSED");
