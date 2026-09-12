/**
 * Client i18n check: the settings section ("Capability") must render in
 * English unless the host / browser reports a zh locale. Loads the browser
 * bundle in a VM sandbox (no navigator, no host locale service).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");

let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ factory }) { captured = factory(() => ({ createElement() { return {} } })) },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

function applyWith(ctx) {
  let label = null;
  const slots = {
    inject(key, register) { register(); return () => {} },
    register(opts) { label = typeof opts.label === "function" ? opts.label() : opts.label; return () => {} },
  };
  captured.apply({ slots, ...ctx });
  return label;
}

test("client i18n: English default, host zh adoption, table parity", () => {
  assert.ok(captured && captured.apply, "bundle must export apply");
  assert.ok(captured.inject.includes("locale"), "inject must include the locale service");

  // English default with no host locale / no navigator.
  assert.equal(applyWith({}), "Capability");

  // Host locale snapshot shape is { active, locales, revision } -> zh.
  assert.equal(applyWith({ on() {}, locale: { snapshot: () => ({ active: "zh-CN", revision: 1 }) } }), "能力库");

  // Table parity: every key exists in both languages.
  const { I18N } = captured.__i18n;
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.zh).sort());
  assert.equal(I18N.en.sectionLabel, "Capability");
  assert.equal(I18N.zh.sectionLabel, "能力库");
});
