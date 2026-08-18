// Recursive skill provider smoke test: build a nested skill tree, register
// the provider through a mock ctx.skills, and verify list()/get() discover
// `<dir>/SKILL.md` at any depth (and skip flat `.md` files).

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerRecursiveSkillProvider } from "../lib/skill.js";

const base = "D:/Github/dsh-skill-mcp-manager/.test-data/skills";
const dataDir = "D:/Github/dsh-skill-mcp-manager/.test-data";

await rm(base, { recursive: true, force: true });
await mkdir(join(base, "tools", "git"), { recursive: true });
await mkdir(join(base, "design"), { recursive: true });
// A flat .md file that must NOT be treated as a skill.
await writeFile(join(base, "README.md"), "# not a skill\n");

await writeFile(
  join(base, "tools", "git", "SKILL.md"),
  "---\nname: git-workflow\ndescription: Git commit and branch workflow\n---\n\nCommit with conventional messages.\n",
  "utf8",
);
await writeFile(
  join(base, "design", "SKILL.md"),
  "---\ndescription: Design review checklist\n---\n\nFirst paragraph of the design skill body.\n",
  "utf8",
);
await writeFile(
  join(dataDir, "settings.json"),
  JSON.stringify({ customRecursiveDirs: [base] }, null, 2),
  "utf8",
);

const providers = [];
const ctx = {
  skills: {
    registerProvider(factory) {
      providers.push(factory({ signal: new AbortController().signal, invalidate() {} }));
      return () => {};
    },
  },
  logger: { warn() {}, error() {} },
  effect() {
    return () => {};
  },
};

registerRecursiveSkillProvider(ctx, dataDir);
const provider = providers[0];

console.log("provider name:", provider.name);

const { candidates, complete } = await provider.list({});
console.log("complete:", complete);
console.log("candidates:", candidates.map((c) => c.name).join(", "));

const failed = [];
if (provider.name !== "skill-mcp-manager-recursive") failed.push("wrong provider name");
if (!candidates.some((c) => c.name === "git-workflow")) failed.push("missing git-workflow (frontmatter name)");
if (candidates.some((c) => c.name === "tools-git")) failed.push("path name should be overridden by frontmatter name");
if (!candidates.some((c) => c.name === "design")) failed.push("missing design (path-derived name)");
if (candidates.some((c) => c.name === "README" || c.name === "readme")) failed.push("flat README.md was wrongly scanned as a skill");

const git = candidates.find((c) => c.name === "git-workflow");
const def = await provider.get(git, {});
console.log("git-workflow definition content:", JSON.stringify(def?.content));
if (!def || def.content !== "Commit with conventional messages.") failed.push("get() returned wrong content");
if (def?.invocation?.modelInvocable !== true) failed.push("default modelInvocable should be true");

if (failed.length > 0) {
  console.log("SKILL SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("SKILL SMOKE TEST PASSED");
