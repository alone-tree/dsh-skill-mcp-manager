// Recursive skill discovery (M1).
//
// Scans `customRecursiveDirs` (from settings.json) for `<dir>/SKILL.md` bundles
// at ANY depth and registers them as a skill provider. Flat `<name>.md` files
// are never treated as skills. Frontmatter parsing mirrors
// dsh-skill-filesystem; a missing frontmatter `name` falls back to the
// kebab-cased path relative to the configured root.

import { join, relative, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";

const PROVIDER_NAME = "skill-mcp-manager-recursive";
// Below every official filesystem rank (100..500): on a name conflict the
// official provider wins.
const PROVIDER_RANK = 0;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DERIVED_DESCRIPTION = 200;

// Register the recursive provider synchronously (during apply); settings.json
// is read lazily inside list() so registration stays in the apply fiber.
export function registerRecursiveSkillProvider(ctx, dataDir) {
  ctx.skills.registerProvider((control) => ({
    name: PROVIDER_NAME,
    async list(options) {
      const settings = await loadSettings(dataDir);
      const roots = settings.customRecursiveDirs;
      if (!Array.isArray(roots) || roots.length === 0) return { candidates: [], complete: true };
      const candidates = [];
      for (const root of roots) {
        if (typeof root !== "string" || root.length === 0) continue;
        const found = await scanRoot(root, control.signal, ctx);
        candidates.push(...found);
      }
      return { candidates, complete: true };
    },
    async get(candidate, options) {
      const locator = candidate.locator;
      const parsed = await readSkillFile(locator.path, control.signal, ctx, locator.fallbackName);
      if (parsed === undefined) return undefined;
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: parsed.invocation,
        source: "custom",
        provider: PROVIDER_NAME,
        resourceBase: { kind: "directory", path: locator.directory },
        path: locator.path,
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        content: parsed.content,
      };
    },
  }));
}

async function scanRoot(root, signal, ctx) {
  const candidates = [];
  async function walk(dir) {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childDir = join(dir, entry.name);
      const skillFile = join(childDir, "SKILL.md");
      const fallbackName = toKebabCase(relative(root, childDir));
      const locator = { path: skillFile, directory: childDir, fallbackName };
      const parsed = await readSkillFile(skillFile, signal, ctx, fallbackName);
      if (parsed !== undefined) {
        candidates.push({
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          invocation: parsed.invocation,
          provider: PROVIDER_NAME,
          source: "custom",
          rank: PROVIDER_RANK,
          locator,
          resourceBase: { kind: "directory", path: childDir },
          path: skillFile,
          ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        });
      }
      await walk(childDir);
    }
  }
  await walk(root);
  return candidates;
}

async function readSkillFile(path, signal, ctx, fallbackName) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  signal?.throwIfAborted();
  const frontmatter = parseFrontmatter(raw);
  if (frontmatter === undefined) return undefined;
  const name = stringField(frontmatter.data, "name") ?? fallbackName;
  const description = stringField(frontmatter.data, "description") ?? deriveDescription(frontmatter.body);
  if (!isSkillName(name) || description === undefined || description.length === 0) return undefined;
  let invocation;
  try {
    invocation = parseInvocationPolicy(frontmatter.data);
  } catch {
    return undefined;
  }
  return {
    name,
    description,
    ...optionalString(frontmatter.data, "whenToUse"),
    invocation,
    ...optionalMetadata(frontmatter.data),
    content: frontmatter.body.trim(),
  };
}

// ── frontmatter (mirrors dsh-skill-filesystem) ─────────────────────────────

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return undefined;
  let parsed;
  try {
    parsed = parse(raw.slice(start, closing.start));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return { data: parsed, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(data, key) {
  const value = stringField(data, key);
  return value !== undefined ? { [key]: value } : {};
}

function optionalMetadata(data) {
  const value = data.metadata;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { metadata: value } : {};
}

function parseInvocationPolicy(data) {
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on":
        return true;
      case "false":
      case "no":
      case "off":
        return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function isSkillName(name) {
  return typeof name === "string" && SKILL_NAME_PATTERN.test(name);
}

function toKebabCase(relPath) {
  return relPath
    .split(sep)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("-");
}

function deriveDescription(body) {
  const firstParagraph = body.split(/\n\s*\n/, 1)[0] ?? "";
  const normalized = firstParagraph.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= MAX_DERIVED_DESCRIPTION ? normalized : `${normalized.slice(0, MAX_DERIVED_DESCRIPTION - 3)}...`;
}

// ── settings ───────────────────────────────────────────────────────────────

async function loadSettings(dataDir) {
  try {
    const text = await readFile(join(dataDir, "settings.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object") return {};
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}
