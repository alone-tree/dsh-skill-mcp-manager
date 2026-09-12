// Watcher smoke test: editing/adding a skill under a configured root must
// trigger control.invalidate(), so the provider re-discovers without restart.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerRecursiveSkillProvider } from "../lib/skill.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const base = ".test-data/watcher";
const dataDir = ".test-data";

await rm(base, { recursive: true, force: true });
await mkdir(base, { recursive: true });
await writeFile(join(dataDir, "settings.json"), JSON.stringify({ customRecursiveDirs: [base] }), "utf8");

let invalidateCount = 0;
let effectDisposer = null;
const ctx = {
  skills: {
    registerProvider(factory) {
      factory({
        signal: new AbortController().signal,
        invalidate: () => {
          invalidateCount += 1;
        },
      });
      return () => {};
    },
  },
  effect(cb) {
    effectDisposer = cb();
    return () => {};
  },
  logger: { warn() {}, error() {} },
};

registerRecursiveSkillProvider(ctx, dataDir);

// Let the async watcher setup settle (loadSettings + fs.watch).
await new Promise((resolve) => setTimeout(resolve, 600));

const baseline = invalidateCount;
console.log("baseline invalidate count:", baseline);

// Add a new nested skill → should trigger invalidate.
await mkdir(join(base, "nested", "new-skill"), { recursive: true });
await writeFile(
  join(base, "nested", "new-skill", "SKILL.md"),
  "---\nname: new-skill\ndescription: A freshly added skill\n---\n\nBody.\n",
  "utf8",
);

await new Promise((resolve) => setTimeout(resolve, 800));
console.log("invalidate count after adding a skill:", invalidateCount);

if (invalidateCount <= baseline) {
  console.log("WATCHER TEST FAILED: invalidate was not called");
  if (effectDisposer) effectDisposer();
  process.exit(1);
}

if (effectDisposer) effectDisposer();
console.log("WATCHER TEST PASSED");
