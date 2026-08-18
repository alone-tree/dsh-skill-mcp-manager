# Changelog

All notable changes to dsh-skill-mcp-manager are documented here.

## [0.1.2] — unreleased (M1/M2 backend)

### Added

- **M1 Skill**: recursive skill provider that scans `customRecursiveDirs` for `<dir>/SKILL.md` at any depth (including the root directory itself), parses YAML frontmatter (mirroring dsh-skill-filesystem), and derives kebab-case names from the relative path when `name` is absent.
- **Watcher**: `fs.watch` on configured roots with a 200ms debounce → `control.invalidate()`, so added/edited/deleted skills are re-discovered without a restart.
- **M2 reconcile**: writes a `disabled: true` shadow entry per active (non-disabled) registry entry into the profile's `cordis.patch.yml`, so config survives uninstalling the plugin as a static dsh-mcp-client fallback. Writes only on change, with a `.bak-<timestamp>` backup.
- **`/prepare-uninstall` command**: hands managed entries back to the native dsh-mcp-client (drops `disabled: true`) before uninstalling the plugin. Registered via `ctx.commands` when available.

### Fixed

- Discovered a skill located at the recursive root itself (e.g. `global-skills/SKILL.md`), which the initial scan missed.

## [0.1.0] — M0

### Added

- `registry.json` (version 1) as the authoritative MCP registry.
- Three tiers: `eager` / `on-demand` / `disabled`.
- Model-facing tools: `mcp_register` (trial-connect + persist), `mcp_load {name, peek?}` (load/hot-reload), `mcp_call {name, tool, args}` (on-demand bridge).
- Pre-step `mcp-catalog` injection (digest-driven, append-only).
- Eager native registration as `mcp__<server>__<tool>`; on-demand via the `mcp_call` bridge (prefix-stable).
