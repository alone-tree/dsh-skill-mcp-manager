// Frontmatter toggle smoke test: verify setDisableModelInvocation adds /
// removes the `disable-model-invocation` key with a line-level edit that
// preserves the body, other keys, order, and comments. No live DSH required.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setDisableModelInvocation } from "../lib/skill.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const dir = ".test-data/frontmatter";
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const file = join(dir, "SKILL.md");

const original = [
  "---",
  "name: demo-skill",
  "description: Demo skill",
  "# a comment that must survive",
  "---",
  "",
  "Body paragraph.",
  "",
].join("\n");

await writeFile(file, original, "utf8");

const failed = [];

// Disable: the key must be inserted right after the opening `---`.
let r = await setDisableModelInvocation(file, true);
let text = await readFile(file, "utf8");
console.log("after disable:\n" + text);
if (r.changed !== true || r.modelInvocable !== false) failed.push("disable: wrong result");
if (!/^disable-model-invocation: true$/m.test(text)) failed.push("disable: key not added");
if (!text.includes("# a comment that must survive")) failed.push("disable: comment lost");
if (!text.includes("Body paragraph.")) failed.push("disable: body lost");

// Enable: the key must be removed, everything else preserved.
r = await setDisableModelInvocation(file, false);
text = await readFile(file, "utf8");
console.log("after enable:\n" + text);
if (r.changed !== true || r.modelInvocable !== true) failed.push("enable: wrong result");
if (/^disable-model-invocation:/m.test(text)) failed.push("enable: key not removed");
if (text !== original) failed.push("enable: file did not round-trip back to original");

// Re-disable on an already-disabled file should be idempotent-ish (no key dup).
await writeFile(file, "---\nname: x\ndisable-model-invocation: true\n---\n\nBody.\n", "utf8");
await setDisableModelInvocation(file, true);
text = await readFile(file, "utf8");
const matches = text.match(/^disable-model-invocation:/gm) || [];
if (matches.length !== 1) failed.push("re-disable produced duplicate keys");

if (failed.length > 0) {
  console.log("FRONTMATTER SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("FRONTMATTER SMOKE TEST PASSED");
