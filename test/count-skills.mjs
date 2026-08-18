// Count how many skills the recursive provider discovers from the real
// global-skills root (via the live settings.json).

import { registerRecursiveSkillProvider } from "../lib/skill.js";

const providers = [];
const ctx = {
  skills: {
    registerProvider(factory) {
      providers.push(factory({ signal: new AbortController().signal, invalidate() {} }));
      return () => {};
    },
  },
  logger: { warn() {}, error() {} },
};

registerRecursiveSkillProvider(ctx, "C:/Users/Zinger/.dsh/skill-mcp-manager");
const provider = providers[0];
const { candidates, complete } = await provider.list({});
const names = candidates.map((c) => c.name).sort();

console.log("complete:", complete);
console.log("total skills discovered:", candidates.length);
console.log("names:", names.join(", "));
