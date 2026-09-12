// Takeover smoke test (full-merge architecture): boot the plugin against a
// temp DSH_HOME whose profile patch holds native @deepseek-ai/dsh-mcp-client
// rows, and verify it (1) adopts them into the registry (on-demand, or
// disabled when the native row is disabled), (2) MOVES every MCP row into the
// regenerated managed block — no dsh-mcp-client row survives outside it,
// (3) preserves non-MCP content, (4) keeps renamed entries stable across
// reboots (no duplicate ids, no resurrection), and (5) refuses to write a
// patch whose managed rows would duplicate a loader id.

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
  "        toolCallTimeoutMs: 120000",
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

// Point DSH_HOME at the temp home before apply() (resolved lazily at call
// time, so a static import would also work).
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

function dshRowCount(text) {
  return (text.match(/name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/g) || []).length;
}

async function reset() {
  await rm(tmp, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
}

async function writeRegistry(entries) {
  await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
}

await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 100));

const failed = [];

// 1. registry: tavily adopted as on-demand (raw config preserved), off-server
//    as disabled (native disabled flag honored).
const registry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
const byName = new Map(registry.entries.map((e) => [e.name, e]));
console.log("registry entries:", registry.entries.map((e) => `${e.name}[${e.tier}]`).join(", "));
if (byName.get("tavily")?.tier !== "on-demand") failed.push("tavily should adopt as on-demand");
if (byName.get("tavily")?.transport !== "streamable-http") failed.push("tavily transport not mapped");
if (byName.get("tavily")?.systemEntryId !== "mcp-tavily") failed.push("tavily systemEntryId not mapped");
if (byName.get("tavily")?.rawConfig?.toolCallTimeoutMs !== 120000) failed.push("tavily rawConfig not preserved");
if (byName.get("off-server")?.tier !== "disabled") failed.push("off-server should adopt as disabled (native disabled)");

// 2. patch: native rows MOVED into the managed block; nothing survives outside.
const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- resulting patch ----\n" + patch);
const startMarker = patch.indexOf("# ── Managed MCP servers");
if (!patch.includes("# test native section — must survive byte-for-byte")) failed.push("native comment lost");
if (startMarker < 0) failed.push("managed marker missing");
if (!patch.includes("End managed MCP servers (dsh-skill-mcp-manager)")) failed.push("managed end marker missing");
const prefixPart = startMarker >= 0 ? patch.slice(0, startMarker) : patch;
if (prefixPart.includes("@deepseek-ai/dsh-mcp-client")) failed.push("a dsh-mcp-client row survived outside the managed block");
if (dshRowCount(patch) !== 2) failed.push(`expected 2 dsh-mcp-client rows (merged), got ${dshRowCount(patch)}`);
if ((patch.match(/- id: mcp-tavily/g) || []).length !== 1) failed.push("mcp-tavily row not merged exactly once");
const blockPart = patch.slice(startMarker);
if (!blockPart.includes("serverName: tavily")) failed.push("merged tavily row lost its serverName");
if (!blockPart.includes("toolCallTimeoutMs: 120000")) failed.push("merged tavily row lost raw config fields");
if (!blockPart.includes("disabled: true")) failed.push("merged rows must be disabled");
if (!blockPart.includes("serverName: off-server")) failed.push("merged off-server row lost its serverName");

// 3. After-marker non-MCP is kept past the end marker (legacy files with
//    only a start marker; suffix was previously sliced off to EOF).
await reset();
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
if (dshRowCount(afterPatch) !== 2) failed.push(`after-marker: expected 2 merged dsh rows, got ${dshRowCount(afterPatch)}`);

// 4. Non-MCP mixed into the start/end span is relocated after the end marker.
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
  if (!mixedMiddle.includes("- id: mcp-tavily")) failed.push("mixed-middle merged tavily row missing from regenerated span");
}

// 5. Desktop-shaped file: oauth already sits before the start marker, managed
//    span runs to EOF with no end marker. Merge keeps oauth in the prefix.
await reset();
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
  if (desktopPrefix.includes("@deepseek-ai/dsh-mcp-client")) failed.push("desktop-shaped: native row survived outside the block");
}
if (oauthHits(desktopPatch) !== 1) failed.push(`desktop-shaped: expected 1 oauth row, got ${oauthHits(desktopPatch)}`);

// 6. Second reconcile on the merged file is stable (oauth not duplicated).
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const secondPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- second-reconcile patch ----\n" + secondPatch);
if (secondPatch !== desktopPatch) failed.push("second reconcile changed an already-merged patch");
if (oauthHits(secondPatch) !== 1) failed.push(`second reconcile duplicated oauth (got ${oauthHits(secondPatch)})`);

// 7. prepare-uninstall hands the merged block back as enabled native rows.
await writeRegistry([
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
]);
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
  if (!handed.includes("Handed back to native dsh-mcp-client")) {
    failed.push("prepare-uninstall missing handover block");
  }
  if (!handed.includes("mcp-playwright")) failed.push("prepare-uninstall dropped playwright config");
  if (!handed.includes("mcp-tavily")) failed.push("prepare-uninstall dropped tavily config");
  const playwrightStart = handed.indexOf("- id: mcp-playwright");
  const playwrightEnd = handed.indexOf("\n    - id:", playwrightStart + 1);
  const playwrightRow = handed.slice(playwrightStart, playwrightEnd < 0 ? undefined : playwrightEnd);
  if (playwrightRow.includes("disabled: true")) {
    failed.push("prepare-uninstall handed playwright back still disabled");
  }
  if (dshRowCount(handed) !== 3) failed.push(`prepare-uninstall expected 3 native rows (tavily, playwright, off-server), got ${dshRowCount(handed)}`);
  const handedEndish = handed.indexOf("Handed back to native dsh-mcp-client");
  const oauthAt = handed.indexOf("- id: llm-grok-build-oauth");
  if (oauthAt < 0) failed.push("prepare-uninstall dropped suffix oauth");
  else if (handedEndish >= 0 && oauthAt < handedEndish) {
    failed.push("prepare-uninstall moved oauth before the handover block");
  }
  if (oauthHits(handed) !== 1) failed.push(`prepare-uninstall oauth copies: ${oauthHits(handed)}`);
}

// 8. Rename safety: an entry renamed after adoption (name no longer matches
//    the original serverName) must not be re-imported nor duplicated on the
//    next boot; the merged row carries the NEW name.
await reset();
await writeRegistry([
  {
    id: "tavily2",
    name: "tavily2",
    tier: "on-demand",
    transport: "streamable-http",
    url: "http://127.0.0.1:1/mcp/",
    systemEntryId: "mcp-tavily",
  },
]);
await writeFile(join(profileDir, "cordis.patch.yml"), nativePatch, "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const renamedPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
const renamedRegistry = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
console.log("---- renamed patch ----\n" + renamedPatch);
console.log("renamed registry entries:", renamedRegistry.entries.map((e) => e.name).join(", "));
if (renamedRegistry.entries.length !== 2) failed.push(`rename: expected 2 entries (tavily2 + absorbed off-server), got ${renamedRegistry.entries.length}`);
if (renamedRegistry.entries[0]?.name !== "tavily2") failed.push("rename: renamed entry lost");
if (renamedRegistry.entries.some((e) => e.name === "tavily")) failed.push("rename: old serverName resurrected as a new entry");
if (dshRowCount(renamedPatch) !== 2) failed.push(`rename: expected exactly 2 merged rows, got ${dshRowCount(renamedPatch)}`);
if (!renamedPatch.includes("serverName: tavily2")) failed.push("rename: merged row does not carry the new name");
if (/serverName: tavily$/m.test(renamedPatch)) failed.push("rename: old serverName still present in the patch");
if ((renamedPatch.match(/- id: mcp-tavily/g) || []).length !== 1) failed.push("rename: mcp-tavily row duplicated");

// 9. Duplicate-id self-check: two registry entries claiming the same row id
//    must abort the patch write (keep the file untouched) instead of writing
//    a composition that cannot boot.
await reset();
await writeRegistry([
  { id: "a", name: "alpha", tier: "on-demand", transport: "streamable-http", url: "http://127.0.0.1:1/mcp/", systemEntryId: "mcp-tavily" },
  { id: "b", name: "beta", tier: "on-demand", transport: "streamable-http", url: "http://127.0.0.1:1/mcp/", systemEntryId: "mcp-tavily" },
]);
const beforeSelfCheck = nativePatch;
await writeFile(join(profileDir, "cordis.patch.yml"), beforeSelfCheck, "utf8");
await apply(ctx, { dataDir, profile: "test", importNativeMcp: true });
await new Promise((resolve) => setTimeout(resolve, 50));
const selfCheckPatch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
console.log("---- duplicate-id self-check patch ----\n" + selfCheckPatch);
if (selfCheckPatch !== beforeSelfCheck) failed.push("duplicate-id self-check: the patch was modified despite the collision");
if (selfCheckPatch.includes("Managed MCP servers")) failed.push("duplicate-id self-check: managed block written despite the collision");

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  console.log("IMPORT SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("IMPORT SMOKE TEST PASSED");
