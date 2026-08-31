# AGENTS — dsh-skill-mcp-manager 开发维护指南

面向未来 AI / 人类开发者。改代码前先读这份文件 + `docs/DESIGN.zh.md`（程序架构）+ `docs/HANDOFF.md`（交接）+ `IDEAS.md`（未实现想法）。

## 项目是什么

**能力库 (Capability)** —— DeepSeek Harness 宿主级插件，把 **Skill 与 MCP 服务器**变成"可视、可管、可注入"的统一目录。

- **MCP**：三档（eager 原生注册 / on-demand 桥 / disabled），模型工具面三件套 `mcp_register` / `mcp_load(peek)` / `mcp_call`，pre-step `mcp-catalog` 注入，boot 导入并接管原生 `dsh-mcp-client` 条目。
- **Skill**：递归扫描 `customRecursiveDirs`（任意深度只认 `<dir>/SKILL.md`，避免把SKILL下的reference或其他文档也扫进去），frontmatter 启停、跨平台删除、系统编辑器打开、shipped 只读护栏。

## 目录结构

```
lib/index.js    宿主主模块：MCP 三件套、连接/快照、导入接管、reconcile、预热、catalog 注入、UI RPC handlers
lib/skill.js    递归 skill provider + frontmatter 编辑（setDisableModelInvocation）
lib/ui.js       HTTP 路由 + /skills /mcp 命令 + 跨平台 open/trash + 密钥打码 + entryView
client/client.js 浏览器端（__ModuleLoader__.load 单文件 bundle，纯 JS React）
test/*.mjs      单元/冒烟测试（发布基线见下方显式清单；e2e-playwright.mjs 需真实运行时，不属于发布基线）
IDEAS.md        未实现想法
CHANGELOG.md    已实现变更日志（最新在最上）
docs/           程序架构（DESIGN.zh.md）、交接（HANDOFF.md）、截图；讨论中专题见 docs/专题/（已归档：按会话隔离MCP实例-2026-08-31-已归档）
```

## 文档维护

- **未实现的想法**只记入 `IDEAS.md`：写用户原话与原意，标未定/需确认项；不要把实现方案写进去。
- **已实现后**：从 `IDEAS.md` 移除该条，记入 `CHANGELOG.md`（最新一节放在文件最上），并同步更新 `docs/DESIGN.zh.md`（程序架构：行为、注入、数据流、已定决策）。本文件里被改动触及的约定、测试清单、目录结构一并改。
- 不要把已落地内容留在 `IDEAS.md`，也不要只改代码不改架构文档。

## 架构

### Host ↔ Client

- 插件是**打包插件**（非 cordis 动态插件）：Host 走 `lib/index.js`，Client 走 `dsh.client` 声明的 `client/client.js`（`__ModuleLoader__.load({id, factory})` 格式，`require("react")`）。
- **RPC = 同源 HTTP 路由**：Host 用 `ctx.webServer.register({kind:"exact", path, handler})`，Client 用 `fetch("/skill-mcp-manager/...")`。
  - `webServer` 是**惰性注册**的服务：必须用 `ctx.inject(["webServer"], (hostCtx) => ...)` 等待，不能同步 `ctx.get("webServer")`（会取到 undefined，路由不注册 → 浏览器拿到 SPA fallback 而非 JSON）。
  - `webServer.register` 对重复 `(kind, path)` 抛错：**GET 和 POST 不能各注册一条同 path 路由**，要合并成一条、handler 内按 `request.method` 分发（见 `/settings` 的实现）。
- POST 路由必须校验 `sameOrigin(request)`（Origin 与 Host 一致），`readJsonBody` 读 body，`sendJson` 统一 JSON 响应。

### 数据

- `~/.dsh/skill-mcp-manager/registry.json` —— MCP 注册表（权威）。
- `~/.dsh/skill-mcp-manager/settings.json` —— 插件设置（`customRecursiveDirs`、`toolDescriptionMaxLength`）。
- `~/.dsh/profiles/<profile>/cordis.patch.yml` —— 被 reconcile 的 patch：托管块（`MANAGED_MARKER` 与 `MANAGED_END_MARKER` 之间）= 影子条目 + 原生条目 `disabled:true` 接管行。

### 每次启动顺序（lib/index.js 的 apply → startup）

1. `loadRegistry(dataDir)`
2. 读 settings.json（覆盖 `toolDescriptionMaxLength`）
3. `importNative()` —— 解析 patch 原生段，把 registry 没有的 `dsh-mcp-client` 条目入库（默认 on-demand；原生 disabled 则 disabled）
4. `reconcile()` —— 写托管块：registry-only 条目写 `disabled:true` 影子 insert + 每个启用原生行追加 `- id: X\n  disabled: true` 覆盖行（接管）
5. `warmSnapshots()` —— 无缓存或 `metaFetchedAt` 为空的条目一次性试连、抓工具快照 + 服务器元信息后关闭，不留下运行实例
6. eager 实例改到各会话首次 `agent/pre-step` 时在该会话 `agent.ctx` 上启动

## 关键设计决策（改动前务必遵守）

- **on-demand 桥 = 前缀零失效**：on-demand 条目不注册原生 schema，模型只看到 `mcp_load/mcp_call/mcp_register`。eager 才原生注册。
- **MCP 运行实例按会话隔离**：同一配置在每个 DSH 会话（含子代理）各自创建/销毁 stdio 子进程或 HTTP 连接。eager 工具注册到该会话的 `agent.ctx`，不写入 Host 全局工具表。配置（注册表、档位、黑名单、密钥、备注）仍全局共享。
- **名称语义**：`entry.name`（本地名）= 模型命名空间，必须 `[A-Za-z0-9_-]{1,32}`（拼进 `mcp__<name>__<tool>`）；`entry.serverName`（服务器自报名）= 只读元信息，来自 `serverInfo.name`，可与本地名不同。
- **本地 `description` 已删除**：描述完全来自服务器自报 `serverDescription`；`mcp_register` 无 `description` 参数。`notes` 是用户维护，永不被覆盖。
- **元信息字段**：`serverName / serverVersion / serverTitle / serverDescription / websiteUrl / instructions / capabilities / metaFetchedAt`，由 `applyServerMetadata(entry, connection)` 在连接时填充，只读。
- **导入接管 = 两阶段靠档位规避**：默认 on-demand 不注册原生工具，所以「导入 + 写 disabled」能在同一次 boot 完成、无重名冲突；若某条目被用户切成 eager，才回到「关原生防重名」语义（依赖接管行已写好）。
- **管理页 Skill 列表要带 preset scope**：内建 `dsh-skill-filesystem` 挂在 agent preset 层。`ctx.skills.list()` 不传 `scope` 只看全局层（本插件递归 provider）；AI 目录注入传 `scope: agent` 所以能看到 `~/.dsh/skills`。Host UI 用 `ctx.get("agentPresets")?.standingKeyFor()` 作为 scope。
- **shipped 技能只读**：路径含 `node_modules` 或 `app.asar` 的技能（如 cordis preset 的）只能查看/打开，禁止启停/删除（`isReadonlySkillPath`）。
- **只替换起止标记之间**：`reconcile` / `prepare-uninstall` 只重写 `MANAGED_MARKER`…`MANAGED_END_MARKER` 中间的本插件 MCP 行（影子 insert + 接管行）；标记前、结束标记后 byte-for-byte 保留。夹在中间的非 MCP 原样挪到结束标记之后。旧文件只有起始标记时，起始之后能认出的 MCP 当中间、认不出的当后缀，并补上结束标记。写前 `.bak-<ts>` 备份。
- **目录注入 digest 驱动**：`catalogDigest` 含 serverDescription + 启用工具的名称/描述；变了才重新注入（追加替换，不改历史）。是否已注入看会话 surface 上可见的 `mcp-catalog`（对齐内建 `skill-catalog`），不要用进程内 WeakMap：压缩会把旧目录移出 surface，digest 未变也必须重注。
- **MCP 单工具禁用 = 黑名单 + 双调用边界**：`entry.disabledTools` 保存原始工具名，新工具默认启用；禁用工具从 eager 注册、目录和 `mcp_load` 隐藏，但安全保证来自 eager `execute` 与 `mcp_call` 在 `tools/call` 前再次拒绝。`mcp_register` 不提供黑名单修改参数，只有管理 UI 可改。已开始的调用不强制中断。

## 编码约定

- **纯 JavaScript**：Host 与 Client 都不经过 TS/JSX/bundler 转换。Client 用 `React.createElement(...)`，**禁止 JSX / TypeScript / import / require**（client.js 里唯一的外部依赖是 `require("react")`）。
- 模块为 ESM（`type: module`）。
- 错误处理：handler 抛错 → 路由层统一 `400 {ok:false,error}`；拒绝/校验失败用 `throw`，不用返回 `{ok:false}` 的 200。

## 开发 / 测试 / 安装

```bash
# 依赖
pnpm install --config.auto-install-peers=true

# 语法检查
node --check lib/index.js
node --check lib/skill.js
node --check lib/ui.js
node --check client/client.js

# 测试基线（全绿）
node test/smoke.mjs            # 三件套 + 命令注册
node test/schema-check.mjs     # 工具 schema 校验
node test/skill-smoke.mjs      # 递归 provider
node test/watcher-smoke.mjs    # watcher 热生效
node test/import-smoke.mjs     # 原生导入 + 接管（隔离 DSH_HOME，勿连真实网络）
node test/ui-smoke.mjs         # HTTP 路由 + 只读护栏 + ctx.inject 路径
node test/frontmatter-smoke.mjs# frontmatter 启停写入
node test/catalog-smoke.mjs     # 压缩后 mcp-catalog 按 surface 重注
node test/tool-disable-smoke.mjs# 单工具黑名单：隐藏、原生注册过滤、桥/旧 execute 拒绝、UI 持久化
node test/session-isolate-smoke.mjs# 会话级 MCP 实例隔离：双会话进程、销毁互不影响、刷新快照不共享实例

# 重装进 desktop profile（file: 依赖要 remove+add 才刷新）
cd ~/.dsh/profiles/desktop
pnpm remove dsh-skill-mcp-manager
pnpm add "file:D:/Github/dsh-skill-mcp-manager"
# 然后重启 DSH
```

## 发布（GitHub ↔ npm 必须同步，同等重要）

**每次发新版，GitHub 发布和 npm `publish` 都要一起做，缺一不可、同等重要。** 不要只推 GitHub 而漏发 npm，也不要只发 npm 而不同步 GitHub。

- **版本号必须一致**：`package.json` 的 `version` 与 Git tag 必须相同（如 `1.0.1` / `v1.0.1`）；npm 同一版本号**不能重复发布**。
- **为什么 npm 不能漏**：市场（`dsh-market`，包括 DSH Desktop）从 npm registry 安装，且**托管安装只认“已发布且版本号精确”的包**——只更新 GitHub、npm 不发，用户既装不了新品也更不了级。
- **发布认证**：npm 包已配置 GitHub Actions Trusted Publisher（OIDC），对应仓库 `alone-tree/dsh-skill-mcp-manager` 和 `.github/workflows/publish.yml`；不依赖某台电脑的 npm 登录、Token 或 OTP。npm 包页面的 Trusted Publisher 必须允许 `npm publish`。
- **自动发布工作流**：`.github/workflows/publish.yml` 在推送 `v*.*.*` tag 时自动运行语法检查、发布基线测试，并执行 `npm publish --provenance --access public`。发布基线是上方显式列出的测试，不要用 `node test/*.mjs`（其中 `e2e-playwright.mjs` 需要真实运行时）。
- **流程（每次发版）**：
  1. 修改 `package.json` 的 `version`（bump）和 `CHANGELOG.md`
  2. 按上方显式清单运行语法检查和发布基线测试
  3. 提交并推送 `main`
  4. 创建并推送同名 tag（如 `git tag v1.0.1 && git push origin v1.0.1`）
  5. 等待 GitHub Actions 成功，并确认 `https://registry.npmjs.org/<name>/latest` 返回该精确版本
- **跨电脑发布**：发布由 GitHub Actions 执行，不绑定当前电脑；任何有仓库推送权限的电脑，或 GitHub 网页创建带新 tag 的 Release，都可以触发。当前工作流监听 tag push，复用已有 tag 不会重新发布。
- **发布成功后市场才能安装/更新**；否则报 `DSH Desktop managed installation requires an npm package with an exact published version`。

## 常见坑

- **测试不能碰真实 profile**：测试里 `profile` 用 `"__test__"`（不存在）且 `importNativeMcp: false`，否则 `importNative`/`reconcile` 会读写真实 `~/.dsh/profiles/web|desktop/cordis.patch.yml`（历史上污染过一次）。
- **import-smoke 的 MCP URL 用本地死端口**（`http://127.0.0.1:1/`）：预热会尝试连接，别让它真连外部服务。
- **前端加了新的 GET+POST 同 path 路由**：必须合并成单条 handler（见上文）。
- **bundle 自动挂载 + 用户补丁旧 insert 行 = 组合无法启动**（2026-08-28 实际发生过）：包自带的 `cordis.patch.yml`（`dsh.bundle.patch`）会自动 insert 挂载行；从手动挂载时代升级过来的 profile 若还留着同 id 的手写 insert 行，组合里出现两行同 id，所有插件更新的 trial 校验都会失败回滚，且**下次重启无法启动**。修复：用户补丁里改成同 id 的纯配置覆盖行（不写 insert）。本机 desktop profile 已于 2026-08-28 修复并校验通过。
- **新增配置项**：记得同步 `Config` schema、`cordis.patch.example.yml`、README 配置表。
