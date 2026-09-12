// Verify the tool definitions pass the real dsh-tools registration-time
// validation: ctx.tools.register() calls assertSupportedJsonSchema(output.schema),
// and parameters must be losslessly JSON-serializable (snapshotJsonValue).

import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { apply } from "../lib/index.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const defs = [];
const ctx = {
  tools: {
    register(d) {
      defs.push(d);
      return () => {};
    },
  },
  skills: {
    registerProvider() {
      return () => {};
    },
  },
  on() {
    return () => {};
  },
  effect() {
    return () => {};
  },
  get() {
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir: ".test-data", profile: "__test__", importNativeMcp: false });

let failed = false;
for (const d of defs) {
  try {
    assertSupportedJsonSchema(d.output.schema);
    JSON.stringify(d.parameters); // throws on circular/undefined values
    console.log(`OK  ${d.name}  (output.schema + parameters valid)`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${d.name}: ${error.message}`);
  }
}

if (failed) {
  console.log("SCHEMA CHECK FAILED");
  process.exit(1);
}
console.log("SCHEMA CHECK PASSED");
