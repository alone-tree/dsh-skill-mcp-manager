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
  "        url: 'http://127.0.0.1:1/mcp/'",
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

const commands = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect() { return () => {}; },
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
  logger: { warn() {}, error() {}, info() {} },
};

function lastPrepareUninstall() {
  const found = commands.filter((item) => item.name === "prepare-uninstall");
  return found[found.length - 1];
}

function oauthHits(text) {
  return (text.match(/llm-grok-build-oauth/g) || []).length;
}

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
if (!patch.includes("End managed MCP servers (dsh-skill-mcp-manager)")) failed.push("managed end marker missing");

// 3. No shadow insert for native entries (their native row is the mirror).
const shadowInsertCount = (patch.match(/name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/g) || []).length;
// native rows keep 2 occurrences (the two insert rows); no extra shadow rows added.
if (shadowInsertCount !== 2) failed.push(`expected 2 dsh-mcp-client rows (native only), got ${shadowInsertCount}`);

// 4. After-marker non-MCP is kept past the end marker (legacy files with
//    only a start marker; suffix was previously sliced off to EOF).
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(profileDir, { recursive: true });
const afterMarkerPatch = [
  nativePatch.trimEnd(),
  "",
  "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──",
  "- id: mcp-tavily",
  "  disabled: true",
  "# dsh-coding-subscription-oauth — must survive after the managed span",
  "- id: llm-grok-build-oauth",
  "  config:",
  "    proxy: http://127.0.0.1:17891",
  "    proxyKimi: false",
  "",
].join("\n");
await writeFile(join(profileDir, "cordis.patch.yml"), afterMarkerPatch, "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const afterPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- after-marker patch ----\n" + afterPatch);
const afterEnd = afterPatch.indexOf("End managed MCP servers (dsh-skill-mcp-manager)");
if (afterEnd < 0) failed.push("after-marker case: end marker missing");
else {
  const afterTail = afterPatch.slice(afterEnd);
  if (!afterTail.includes("- id: llm-grok-build-oauth")) failed.push("after-marker oauth not kept after end marker");
  if (!afterTail.includes("proxy: http://127.0.0.1:17891")) failed.push("after-marker oauth config lost");
}
const afterStart = afterPatch.indexOf("Managed MCP servers");
if (afterStart >= 0 && afterEnd >= 0) {
  const middle = afterPatch.slice(afterStart, afterEnd);
  if (middle.includes("llm-grok-build-oauth")) failed.push("after-marker oauth still inside managed span");
}

// 5. Non-MCP mixed into the start/end span is relocated after the end marker.
await writeFile(join(profileDir, "cordis.patch.yml"), [
  nativePatch.trimEnd(),
  "",
  "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──",
  "- id: mcp-tavily",
  "  disabled: true",
  "- id: llm-grok-build-oauth",
  "  config:",
  "    proxy: http://127.0.0.1:17891",
  "    proxyKimi: false",
  "# ── End managed MCP servers (dsh-skill-mcp-manager) ──",
  "",
].join("\n"), "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const mixedPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- mixed-middle patch ----\n" + mixedPatch);
const mixedEnd = mixedPatch.indexOf("End managed MCP servers (dsh-skill-mcp-manager)");
if (mixedEnd < 0) failed.push("mixed-middle case: end marker missing");
else {
  const mixedTail = mixedPatch.slice(mixedEnd);
  if (!mixedTail.includes("- id: llm-grok-build-oauth")) failed.push("mixed-middle oauth not relocated after end marker");
}
const mixedStart = mixedPatch.indexOf("Managed MCP servers");
if (mixedStart >= 0 && mixedEnd >= 0) {
  const mixedMiddle = mixedPatch.slice(mixedStart, mixedEnd);
  if (mixedMiddle.includes("llm-grok-build-oauth")) failed.push("mixed-middle oauth still inside managed span");
  if (!mixedMiddle.includes("- id: mcp-tavily")) failed.push("mixed-middle takeover row missing from regenerated span");
}

// 6. Desktop-shaped file: oauth already sits before the start marker, managed
//    span runs to EOF with no end marker. Upgrade must keep oauth in the
//    prefix and only append the end marker.
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(profileDir, { recursive: true });
const desktopShaped = [
  nativePatch.trimEnd(),
  "",
  "# dsh-coding-subscription-oauth — already before the managed marker",
  "- id: llm-grok-build-oauth",
  "  config:",
  "    proxy: http://127.0.0.1:17891",
  "    proxyKimi: false",
  "",
  "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──",
  "- id: mcp-tavily",
  "  disabled: true",
  "",
].join("\n");
await writeFile(join(profileDir, "cordis.patch.yml"), desktopShaped, "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const desktopPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- desktop-shaped patch ----\n" + desktopPatch);
const desktopStart = desktopPatch.indexOf("Managed MCP servers");
const desktopEnd = desktopPatch.indexOf("End managed MCP servers (dsh-skill-mcp-manager)");
if (desktopStart < 0) failed.push("desktop-shaped: start marker missing");
if (desktopEnd < 0) failed.push("desktop-shaped: end marker missing");
if (desktopStart >= 0) {
  const desktopPrefix = desktopPatch.slice(0, desktopStart);
  if (!desktopPrefix.includes("- id: llm-grok-build-oauth")) failed.push("desktop-shaped: oauth left the prefix");
  if (!desktopPrefix.includes("proxy: http://127.0.0.1:17891")) failed.push("desktop-shaped: oauth config lost");
}
if (desktopStart >= 0 && desktopEnd >= 0) {
  const desktopMiddle = desktopPatch.slice(desktopStart, desktopEnd);
  if (desktopMiddle.includes("llm-grok-build-oauth")) failed.push("desktop-shaped: oauth moved into managed span");
}
if (oauthHits(desktopPatch) !== 1) failed.push(`desktop-shaped: expected 1 oauth row, got ${oauthHits(desktopPatch)}`);

// 7. Second reconcile on a file that already has start+end+suffix is stable
//    (oauth must not be duplicated).
const afterFirstReconcile = desktopPatch;
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const secondPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- second-reconcile patch ----\n" + secondPatch);
if (secondPatch !== afterFirstReconcile) failed.push("second reconcile changed an already-bounded patch");
if (oauthHits(secondPatch) !== 1) failed.push(`second reconcile duplicated oauth (got ${oauthHits(secondPatch)})`);

// 8. prepare-uninstall keeps suffix oauth; managed span is handed back.
await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "tavily",
      name: "tavily",
      tier: "on-demand",
      transport: "streamable-http",
      url: "http://127.0.0.1:1/mcp/",
      systemEntryId: "mcp-tavily",
    },
    {
      id: "playwright",
      name: "playwright",
      tier: "on-demand",
      transport: "streamable-http",
      url: "http://127.0.0.1:1/mcp/",
      systemEntryId: "mcp-playwright",
    },
  ],
}, null, 2)}\n`, "utf8");
await writeFile(join(profileDir, "cordis.patch.yml"), [
  nativePatch.trimEnd(),
  "",
  "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──",
  "- insert:",
  "    - id: mcp-playwright",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: playwright",
  "        transport: streamable-http",
  "        url: 'http://127.0.0.1:1/mcp/'",
  "      disabled: true",
  "- id: mcp-tavily",
  "  disabled: true",
  "# ── End managed MCP servers (dsh-skill-mcp-manager) ──",
  "",
  "- id: llm-grok-build-oauth",
  "  config:",
  "    proxy: http://127.0.0.1:17891",
  "    proxyKimi: false",
  "",
].join("\n"), "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const prepare = lastPrepareUninstall();
if (!prepare) failed.push("prepare-uninstall command not registered");
else {
  const result = await prepare.handler();
  if (result?.kind === "error") failed.push(`prepare-uninstall error: ${result.text}`);
  const handed = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  console.log("---- prepare-uninstall patch ----\n" + handed);
  if (handed.includes("Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries)")) {
    failed.push("prepare-uninstall left the managed start marker");
  }
  if (handed.includes("- id: mcp-tavily\n  disabled: true")) {
    failed.push("prepare-uninstall left the takeover row");
  }
  if (!handed.includes("Handed back to native dsh-mcp-client")) {
    failed.push("prepare-uninstall missing handover block for shadow entry");
  }
  if (!handed.includes("mcp-playwright")) failed.push("prepare-uninstall dropped shadow playwright config");
  if (handed.includes("disabled: true") && /mcp-playwright[\s\S]*disabled:\s*true/.test(handed)) {
    failed.push("prepare-uninstall handed playwright back still disabled");
  }
  const handedEndish = handed.indexOf("Handed back to native dsh-mcp-client");
  const oauthAt = handed.indexOf("- id: llm-grok-build-oauth");
  if (oauthAt < 0) failed.push("prepare-uninstall dropped suffix oauth");
  else if (handedEndish >= 0 && oauthAt < handedEndish) {
    failed.push("prepare-uninstall moved oauth before the handover block");
  }
  if (oauthHits(handed) !== 1) failed.push(`prepare-uninstall oauth copies: ${oauthHits(handed)}`);
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  console.log("IMPORT SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("IMPORT SMOKE TEST PASSED");
