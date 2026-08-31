# Changelog

All notable changes to dsh-skill-mcp-manager (能力库 / Capability) are documented here.

## [1.0.1] — 2026-08-28

### Added

- MCP 单工具启停：每个条目以 `disabledTools` 黑名单持久保存禁用工具，新发现工具默认启用。管理页在每个工具名前增加“启用/禁用”二档下拉框，禁用项文字变灰。
- 禁用工具不进入 eager 原生注册、`mcp-catalog` 或 `mcp_load`/peek 返回；`mcp_call` 与 eager `execute` 在实际调用前强制检查黑名单，历史工具名或旧 schema 无法绕过。已开始的调用不强制中断。测试：`test/tool-disable-smoke.mjs`。

### Fixed

- 上下文压缩后 `mcp-catalog` 不再注入：改为按会话 surface 上可见的 digest 判断是否重注（对齐内建 `skill-catalog`），不再用进程内 WeakMap。压缩把旧目录移出 surface 后会重新追加。测试：`test/catalog-smoke.mjs`。
- 管理页 Skill 列表看不到 AI 能看到的 Skill（如经 `~/.dsh/skills` Junction 接入的 `capability-entry`）：内建 `dsh-skill-filesystem` 挂在 agent preset 层，`listSkills` 改为用 `agentPresets.standingKeyFor()` 作为 `ctx.skills.list/get` 的 scope。

## [1.0.0] — 2026-08-19

### Added

- **Client UI (能力库 / Capability)**:
  - A single Settings section ("能力库") with **SKILL** and **MCP** tabs.
  - SKILL management: frontmatter model-visibility switch, open in system editor, cross-platform delete (recycle bin / trash). Shipped/read-only skills (under `node_modules`/`app.asar`) are view-only.
  - MCP management: tier switching, entry details, secret masking/reveal, load / peek / disconnect, delete entry. Adjustable **tool-description truncation** in the UI (persisted to `settings.json`, hot for the catalog).
- **Native MCP import + takeover** (`importNativeMcp`, default on): on boot, every `@deepseek-ai/dsh-mcp-client` row in the profile's `cordis.patch.yml` is imported into the registry (on-demand by default; already-disabled stays disabled) and taken over via an id-targeted `disabled: true` override — the capability library becomes the single entry point after one restart.
- **Boot warm-up**: entries without a cached snapshot (or without fetched metadata) are connected once, concurrently, to capture real tool names/descriptions — the catalog is useful from the first session.
- **Server metadata capture**: the initialize handshake's `serverName / serverVersion / serverTitle / serverDescription / websiteUrl / instructions / capabilities` are stored per entry (read-only) and surfaced in `mcp_load` and the UI. `metaFetchedAt` tracks when metadata was last attempted.
- **Tool descriptions in the catalog**: each tool is listed with its (truncated) description — the model can see what a tool does without `mcp_load`. Truncation default 150 chars (`toolDescriptionMaxLength`).
- **Removed the local `description` field**: `mcp_register` no longer takes a `description`; descriptions come from the server (`serverDescription`). `notes` is documented as user-maintained and never overwritten.
- Documentation: `AGENTS.md`, screenshots in README, `CHANGELOG`.

### Fixed

- `webServer` is acquired via `ctx.inject(["webServer"], …)` (it is provided lazily); a synchronous `ctx.get("webServer")` returned `undefined`, so routes never registered and the browser received the SPA fallback instead of JSON.
- `webServer.register` rejects duplicate `(kind, path)`: the `GET`/`POST /skill-mcp-manager/settings` routes are now one handler dispatching on method (previously the POST returned 405).
- Tests now run against an isolated profile (`__test__`) with `importNativeMcp: false`, so they no longer mutate the real web/desktop `cordis.patch.yml`; the import test uses a local dead-port URL to avoid real network calls.

## [0.1.2] — M1/M2 backend

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
