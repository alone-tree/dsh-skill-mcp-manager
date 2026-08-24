// UI bridge smoke test: mount the plugin against a mock ctx that supplies a
// full skills service + a webServer route sink, then drive the registered
// HTTP routes directly. Verifies (1) routes + commands are registered,
// (2) skill listing marks shipped/read-only skills, and (3) toggle/delete are
// refused for read-only skills. No live DSH or filesystem writes required.

import { apply } from "../lib/index.js";

const tools = [];
const routes = [];
const commands = [];
let effectDisposer = null;
let preStepListener = null;
let listedWith = null;
let gotWith = null;
const PRESET_SCOPE = { kind: "preset-standing" };

const WRITABLE = {
  name: "my-skill",
  description: "A user skill",
  path: "D:/HermesSync/global-skills/tools/my-skill/SKILL.md",
  source: "custom",
  provider: "skill-mcp-manager-recursive",
  invocation: { modelInvocable: true, userInvocable: true },
};
const SHIPPED = {
  name: "cordis-plugin-development",
  description: "Develop dynamic plugins",
  path: "C:/Users/Zinger/AppData/Local/Programs/DSH Desktop/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md",
  source: "custom",
  provider: "skill-mcp-manager-recursive",
  invocation: { modelInvocable: true, userInvocable: true },
};
const JUNCTION = {
  name: "capability-entry",
  description: "Capability library entry",
  path: "C:/Users/Zinger/.dsh/skills/capability-entry/SKILL.md",
  source: "user-dsh",
  provider: "filesystem",
  invocation: { modelInvocable: true, userInvocable: true },
};

const ctx = {
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  skills: {
    registerProvider() {
      return () => {};
    },
    async list(options = {}) {
      listedWith = options;
      const scoped = options.scope === PRESET_SCOPE ? [JUNCTION] : [];
      return [
        { name: "my-skill", description: "A user skill", invocation: WRITABLE.invocation, source: "custom", provider: "skill-mcp-manager-recursive" },
        { name: "cordis-plugin-development", description: "Develop dynamic plugins", invocation: SHIPPED.invocation, source: "custom", provider: "skill-mcp-manager-recursive" },
        ...scoped.map((skill) => ({ name: skill.name, description: skill.description, invocation: skill.invocation, source: skill.source, provider: skill.provider })),
      ];
    },
    async get(name, options = {}) {
      gotWith = options;
      if (name === "my-skill") return WRITABLE;
      if (name === "cordis-plugin-development") return SHIPPED;
      if (name === "capability-entry" && options.scope === PRESET_SCOPE) return JUNCTION;
      return undefined;
    },
  },
  on(event, handler) {
    if (event === "agent/pre-step") preStepListener = handler;
    return () => {};
  },
  effect(fn) {
    effectDisposer = fn();
    return () => {};
  },
  get(name) {
    if (name === "webServer") {
      return {
        register(route) {
          routes.push(route);
          return () => {};
        },
      };
    }
    if (name === "commands") {
      return {
        register(definition) {
          commands.push(definition);
          return () => {};
        },
      };
    }
    if (name === "agentPresets") {
      return { standingKeyFor: async () => PRESET_SCOPE };
    }
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir: "D:/Github/dsh-skill-mcp-manager/.test-data", profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 100));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method,
    url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return i < chunks.length ? { value: chunks[i++], done: false } : { done: true };
        },
      };
    },
  };
}

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => {
    res.status = status;
  };
  res.end = (chunk) => {
    res.body = chunk;
  };
  return res;
}

const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
const routeByPath = (path) => routes.find((route) => route.path === path);

console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("commands:", commands.map((c) => c.name).join(", "));
console.log("routes:", routes.map((r) => r.path).join(", "));

const failed = [];

for (const name of ["mcp_register", "mcp_load", "mcp_call"]) {
  if (!tools.some((t) => t.name === name)) failed.push(`missing tool ${name}`);
}
for (const name of ["prepare-uninstall", "skills", "mcp"]) {
  if (!commands.some((c) => c.name === name)) failed.push(`missing command ${name}`);
}
for (const path of ["/skill-mcp-manager/skills", "/skill-mcp-manager/skills/toggle", "/skill-mcp-manager/skills/delete", "/skill-mcp-manager/mcp"]) {
  if (!routes.some((r) => r.path === path)) failed.push(`missing route ${path}`);
}

// listSkills: shipped skill must be flagged readonly, writable must not.
{
  const res = makeRes();
  await routeByPath("/skill-mcp-manager/skills").handler(makeReq("GET", "/skill-mcp-manager/skills"), res);
  const { skills } = bodyOf(res);
  console.log("skills:", skills.map((s) => `${s.name}[readonly=${s.readonly}]`).join(", "));
  const writable = skills.find((s) => s.name === "my-skill");
  const shipped = skills.find((s) => s.name === "cordis-plugin-development");
  if (res.status !== 200) failed.push("skills GET status != 200");
  if (writable?.readonly !== false) failed.push("my-skill should be writable");
  if (shipped?.readonly !== true) failed.push("cordis-plugin-development should be readonly");
  const junction = skills.find((s) => s.name === "capability-entry");
  if (junction === undefined) failed.push("capability-entry missing without preset scope");
  if (listedWith?.scope !== PRESET_SCOPE) failed.push("listSkills did not pass preset standing scope");
  if (gotWith?.scope !== PRESET_SCOPE) failed.push("listSkills get() did not pass preset standing scope");
}

// toggleSkill on a read-only skill must be refused (400 + error), no write.
{
  const res = makeRes();
  await routeByPath("/skill-mcp-manager/skills/toggle").handler(
    makeReq("POST", "/skill-mcp-manager/skills/toggle", { name: "cordis-plugin-development", enabled: false }),
    res,
  );
  const body = bodyOf(res);
  console.log("toggle readonly ->", res.status, JSON.stringify(body));
  if (res.status !== 400 || body.ok !== false || !/read-only/.test(body.error || "")) {
    failed.push("toggleSkill did not refuse a read-only skill");
  }
}

// deleteSkill on a read-only skill must be refused.
{
  const res = makeRes();
  await routeByPath("/skill-mcp-manager/skills/delete").handler(
    makeReq("POST", "/skill-mcp-manager/skills/delete", { name: "cordis-plugin-development" }),
    res,
  );
  const body = bodyOf(res);
  console.log("delete readonly ->", res.status, JSON.stringify(body));
  if (res.status !== 400 || body.ok !== false || !/read-only/.test(body.error || "")) {
    failed.push("deleteSkill did not refuse a read-only skill");
  }
}

// Inject path (real host): webServer is provided lazily, so the plugin must
// acquire it via ctx.inject and register routes against the injected service —
// a synchronous ctx.get("webServer") would be undefined here.
{
  const injected = [];
  const ctx2 = {
    tools: { register() { return () => {}; } },
    skills: {
      registerProvider() { return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    on() { return () => {}; },
    effect() { return () => {}; },
    get(name) {
      if (name === "commands") return { register() { return () => {}; } };
      return undefined; // intentionally no "webServer" via get
    },
    inject(deps, callback) {
      const child = {
        webServer: { register(route) { injected.push(route); return () => {}; } },
        get(name) { return name === "commands" ? { register() { return () => {}; } } : undefined; },
        effect() { return () => {}; },
      };
      callback(child);
    },
    logger: { warn() {}, error() {}, info() {} },
  };
  await apply(ctx2, { dataDir: "D:/Github/dsh-skill-mcp-manager/.test-data", profile: "__test__", importNativeMcp: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const paths = injected.map((route) => route.path);
  console.log("inject-path routes:", paths.join(", "));
  if (!paths.includes("/skill-mcp-manager/skills") || !paths.includes("/skill-mcp-manager/mcp")) {
    failed.push("inject path did not register the skill/mcp routes");
  }
}

if (effectDisposer) effectDisposer();

if (failed.length > 0) {
  console.log("UI SMOKE TEST FAILED:", failed.join("; "));
  process.exit(1);
}
console.log("UI SMOKE TEST PASSED");
