// /mcp command dispatch: bare "/mcp" lists servers, "/mcp prepare-uninstall"
// performs the README-documented handover (it previously listed servers and
// silently ignored the argument), and any other argument is a helpful error.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// Scratch DSH_HOME so prepare-uninstall reads/writes a temp profile patch,
// never the user's real ~/.dsh.
const tmp = join(process.cwd(), `.test-mcp-command-${process.pid}`);
const profileDir = join(tmp, "profiles", "__test__");
await rm(tmp, { recursive: true, force: true });
await mkdir(join(tmp, "data"), { recursive: true });
await mkdir(profileDir, { recursive: true });
process.env.DSH_HOME = tmp;

await writeFile(join(profileDir, "cordis.patch.yml"), [
  "# native section",
  "- insert:",
  "    - id: mcp-demo",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: demo",
  "        transport: stdio",
  "        command: node",
  "        args: ['-e', '']",
].join("\n") + "\n", "utf8");

const commands = [];
const routes = [];
const effects = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect(fn) { const disposer = fn(); if (typeof disposer === "function") effects.push(disposer); return () => {}; },
  get(name) {
    if (name === "commands") return { register(definition) { commands.push(definition); return () => {}; } };
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

const failed = [];
try {
  await apply(ctx, { dataDir: join(tmp, "data"), profile: "__test__", importNativeMcp: true });
  const mcp = commands.find((definition) => definition.name === "mcp");
  if (mcp === undefined) failed.push("/mcp command not registered");

  // Bare "/mcp" lists servers.
  const list = await mcp.handler({ rawInput: "" });
  if (list?.kind !== "success" || !list.text.includes("demo")) failed.push(`bare /mcp should list servers: ${JSON.stringify(list)}`);

  // "/mcp prepare-uninstall" hands the managed block back to native.
  const handover = await mcp.handler({ rawInput: "prepare-uninstall" });
  if (handover?.kind !== "success" || !/handed \d+ mcp/i.test(handover.text ?? "")) {
    failed.push(`/mcp prepare-uninstall should hand back entries: ${JSON.stringify(handover)}`);
  }
  const after = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  if (after.includes("Managed MCP servers")) failed.push("prepare-uninstall left the managed marker behind");
  if (!after.includes("mcp-demo") || /disabled:\s*true/.test(after)) failed.push("prepare-uninstall did not re-enable the native row");

  // Underscore alias works too.
  const alias = await mcp.handler({ rawInput: "prepare_uninstall" });
  if (alias?.kind !== "success") failed.push(`prepare_uninstall alias should work: ${JSON.stringify(alias)}`);

  // Unknown argument is a helpful error, not a silent list.
  const bogus = await mcp.handler({ rawInput: "explode" });
  if (bogus?.kind !== "error" || !/unknown \/mcp argument/.test(bogus?.text ?? "")) {
    failed.push(`unknown argument should error helpfully: ${JSON.stringify(bogus)}`);
  }
} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("MCP COMMAND SMOKE FAILED");
  process.exit(1);
}
console.log("MCP COMMAND SMOKE PASSED");
