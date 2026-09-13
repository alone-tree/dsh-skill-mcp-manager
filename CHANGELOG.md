# Changelog

All notable changes to dsh-skill-mcp-manager (能力库 / Capability) are documented here.

## [Unreleased]

### Added

- **历史会话审核 + 一次性修复指引**：改掉写入格式只能保证"以后不再产生坏数据"，救不回已经落盘的旧会话。现在**在启动流程里**（预热等慢步骤之前 `await`）只读扫描 `~/.dsh/sessions` 里 v0 命名的日志，这样首次安装的结果在**页面打开时**就已在屏幕上，而不是用户用了一会儿才发现；代价是首次启动要等扫描完成（有坏日志时很快，干净的大库 30–50 秒，只付一次）。检出受影响会话后在「设置 → 能力库」顶部显示提示、并弹一次浮层通知（浮层的关闭只作用于本次会话，**横幅没有关闭按钮**——误点不可能把真问题藏起来）。整个机制只有记录文件里的一个布尔 `check`：为真才扫；扫到受影响就保持为真并每次启动重新提示；扫到 0 就静默把它改假、跳过汇报、以后不再扫——这一条同时让"已修好"和"从来没有过旧日志"的机器都不再付扫描成本（干净的大库因为无法提前退出，扫得更慢）。只读，绝不写任何会话日志。测试：`test/session-audit-smoke.mjs`。
- **仓库内一次性修复脚本 `tools/repair-legacy-sessions.mjs`**：按帧切分只重压内容变化的那几帧、写前备份、逐行 `JSON.parse` + 序列化回环校验、跨帧对象中止、组装后回读复核；默认试运行，`--apply` 才写入，`--cleanup-backups` 删备份。纯 Node（≥22.15 内置 zstd），无外部依赖、跨平台。测试：`test/repair-tool-smoke.mjs`。
- **修复指引 issue**：https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2 —— 含报错原文（供 AI/搜索命中）、根因、脚本全文，以及给 AI 的分步操作说明；插件的提示与 `/mcp` 命令都指向它。

### Fixed

- **注入 source 改用内核已认识的插件归属形态，历史会话不再整体打不开**：`mcp-catalog` 是插件自定义的 `source.kind`，既不在内核 released 迁移边的封闭集合（v2→v3 `SOURCE_KINDS`，15 个内置 kind）里，也不在 v0→v1 `pluginSourceValue` 允许的成员集内。DSH 桌面端 2.0.9 起打开旧会话必然走 v0→v3 迁移链，因此本机 574 个 v0 会话中 **552 个整体打不开**（`cannot safely transform unclassified message source`），而插件在 v3 新会话里一切正常——被拒的只有迁移这一条路径，因为 v3 读写不审计 kind（2026-09-11 事故）。现改为 `source: {kind:"plugin", plugin:"dsh-skill-mcp-manager"}`：`plugin` 是内核 `MessageSourceMap` 里正式建模的第三方插件形态，只带 `kind`/`plugin` 两个成员，落在每一条 released 迁移边的准入集合内。

### Changed

- **目录注入的判据从 digest 改为注入正文本身**：`plugin` 源只放行 `{kind, plugin}` + `form`/`sections`/`summary`，`digest` 无处安放；而 digest 本就只是 entries 投影的哈希形式，正文（同一份 entries 渲染而来）已随消息 content 持久化，属冗余副本。现在可见性判定取会话 surface 上仍可见的最新一条本插件目录消息，把它的正文与此刻渲染出的正文逐字比对，相同则跳过。业务行为不变：该注入才注入、压缩后重新追加、人类展开看到的仍是模型原文。副作用：2026-09-11 就地修复过的 552 个历史日志正是本形态，插件重新认得它们，续聊不再多注入一次目录。测试 mock 改为回写完整 message（content + source），并新增「source 无正文不得算可见」「他人 source 不得算本插件目录」「已修复的历史日志必须认得」三个用例。

## [1.1.4] — 2026-09-07

### Fixed

- **mcp-catalog 每轮重注（真机 bug）**：可见性判定读取了宿主 Session 上不存在的 `events` 属性（公开 API 是 `eventAt`/`seq`/`snapshotEvents`），导致 `visibleCatalogDigest` 恒为空、每轮对话都重新注入目录。现对齐内建 skill-catalog 模式：`session.eventAt` 倒序遍历持久日志、对 surface 上仍可见的最新 `mcp-catalog` 读 digest 字段对比（digest 缺失/损坏的记录视为「非本插件目录」）。测试 mock 同步改为真机 Session 形状——此前 mock 模拟了不存在的 `session.events` 数组，测试绿而真机每轮失效。

### Changed

- **注入零双重标准**：mcp-catalog 不再声明宿主的结构化 `form: "catalog"`（该表单只渲染 name+description 两列瘦摘要，且多数服务器无自报描述，人类展开只看到一列名字）——缺省/未知 form 由宿主 OpaqueBody 渲染模型正文原文，人类展开「上下文注入」卡片看到的就是模型收到的原文。source 收缩为 `{kind, digest}`：OpaqueBody 的 SourceFields 会显示 source 全部字段，此前携带的 entries JSON 会把同一信息渲染两遍（人类比模型多看一遍冗余）。注入正文与 digest 由同一份 entries 投影派生。升级后首轮会重新注入一次，之后恢复按需注入。

## [1.1.3] — 2026-09-07

### Added

- **`mcp_call` 参数形状守卫**：`tool` 缺失/非字符串、`args` 非对象（含数组/null）在桥接入口直接拒绝，报错附正确调用形状 `{"name","tool","args"}`，不做自动解包。真机实测：当前 DSH 宿主会对未通过工具 schema `required` 校验的调用先清洗参数再传给 handler，所以真实环境下主要由"缺 `tool`"分支拦截；"工具名嵌进 args"的错位形状识别保留为防御性分支（mock 测试直接调 handler 可达）。背景：issue #1（-32602 Invalid request parameters）的根因是调用参数形状错误而非桥接信封 bug——旧宿主+旧插件组合下 `{tool, args}` 被原样塞进 `arguments`，`params.name` 序列化丢失。
- **工具调用错误附上下文**：两类失败路径的错误消息统一追加 `called MCP tool: <server>/<tool>` 与实际发送的 `arguments` JSON（各截断 2000 字符）：① 协议层失败（-32602/-32603/超时等，另附该工具 `inputSchema`）；② 服务端 `isError` 业务错误结果（如"未知工具"——真机实测 Tavily 对未知工具走的就是这条路径，不附 inputSchema，模型刚 `mcp_load` 过已有 schema）。on-demand 桥与 eager 原生 `execute` 两条路径均生效，模型可对照"实际发送了什么"自我修正。代价：单次失败响应最多附加约 4 KB。测试：`test/mcp-call-guard-smoke.mjs`（新增，发布基线同步更新）。

### Fixed

- **`mcp_load` 返回与工具快照补回 `inputSchema`**：`snapshotTools` 与 eager `ensureEager` 此前把工具快照裁剪成 `{name, description}`，导致 `mcp_load`（load/peek 两条路径）与 `registry.json` 持久化快照自 M0 起永远不含参数结构——工具 description 声称 "parameter schemas"、设计文档写明 "return 完整定义"，但渲染层拿不到数据，模型只能靠调用报错反推参数（多动作型工具受影响最重）。现在快照保留服务器自报 `inputSchema`，`mcp_load` 逐工具渲染参数结构，`registry.json` 同步持久化；`mcp-catalog` 目录注入保持只含名称+描述不变。测试：`test/mcp-load-schema-smoke.mjs`（新增，发布基线同步更新）。

## [1.1.2] — 2026-09-02

### Added

- 技能管理页头部计数显示模型可见数量：「N 个技能 · 模型可见 M 个」。M 由前端按每条 Skill 的 `modelInvocable` 过滤得出，随启停操作刷新，关闭部分技能后不再只显示总数。

### Fixed

- Skill 模型可见性开关成功后仅局部更新对应行，不再全量刷新列表或显示成功提示，滚动位置保持不变。

## [1.1.1] — 2026-08-31

### Fixed

- MCP 接管改为**全量合并架构**：吸收阶段扫描整个补丁文件并按行 id（systemEntryId）认领，未认领行吸收进注册表；托管块由注册表整体重生成（每条目恰好一行、disabled，重复 loader id 拒绝写盘），托管块外被认领的原生行从原位置移除（空 insert 块一并清理，非 MCP 内容原样保留）。修复"重命名 MCP 后重启出现同 id 双 insert、DSH 无法启动"的故障类——改名、手写新行、serverName 漂移均安全。测试：`test/import-smoke.mjs`（新增改名安全与重复 id 自检用例）。
- `prepare-uninstall` 把托管块整体交还：所有条目以完整、启用的 insert 写回，disabled 档保留 disabled，不再遗漏。

## [1.1.0] — 2026-08-31

### Added

- MCP 按会话隔离运行实例：同一配置在每个 DSH 会话（含子代理）各自启动 stdio 子进程或 HTTP 连接；eager 工具注册到该会话的 `agent.ctx`。`mcp_load` / `mcp_call` 只作用于当前会话的实例。真机验证：双会话独立进程、并发读取互不干扰、子代理实例随会话自动回收。测试：`test/session-isolate-smoke.mjs`。
- 管理页删除「已连接」「断开」，原「加载」改为「刷新快照」：一次性试连并更新 `registry.json`，不留下运行实例。
- README 补充按会话隔离特性与工具面会话级语义说明。

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
