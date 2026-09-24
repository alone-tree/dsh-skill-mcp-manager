// Environment handed to a local (stdio) MCP process.
//
// The exclusion set matches the harness subprocess seam
// (`@deepseek-ai/dsh-subprocess` `scrubbedParentEnv`): credential-shaped names
// and `DSH_*` are not inherited. When that package is loadable, its function
// is used so the proxy overlay stays the same as the built-in MCP client.
// Explicit entry env is applied after the scrub, so a value the user wrote
// for this tool wins, including a same-named variable the scrub dropped.
//
// A value that is the whole string `$NAME` is replaced with the current
// process environment at spawn time. A missing name becomes an empty string.
// Anything else, including a `$NAME` prefix or `${NAME}`, stays literal.

const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function scrubParentEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith("DSH_")) continue;
    out[key] = value;
  }
  return out;
}

let hostScrub;
function hostScrubber() {
  if (hostScrub === undefined) {
    hostScrub = import("@deepseek-ai/dsh-subprocess")
      .then((mod) => (typeof mod.scrubbedParentEnv === "function" ? mod.scrubbedParentEnv : null))
      .catch(() => null);
  }
  return hostScrub;
}

export function resolveExplicitEnv(env, source = process.env) {
  const out = {};
  if (env === null || typeof env !== "object") return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      if (value !== undefined) out[key] = value;
      continue;
    }
    const match = ENV_REFERENCE.exec(value);
    if (match === null) {
      out[key] = value;
      continue;
    }
    const found = source[match[1]];
    out[key] = found === undefined ? "" : found;
  }
  return out;
}

export async function childEnv(explicit, source = process.env) {
  const scrub = await hostScrubber();
  const base = scrub === null ? scrubParentEnv(source) : scrub();
  return { ...base, ...resolveExplicitEnv(explicit, source) };
}
