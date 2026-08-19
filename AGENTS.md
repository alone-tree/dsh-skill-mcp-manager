# AGENTS — dsh-skill-mcp-manager 开发维护指南

面向未来 AI / 人类开发者。改代码前先读这份文件 + `docs/DESIGN.zh.md`（完整设计）+ `docs/HANDOFF.md`（交接）。

## 项目是什么

**能力库 (Capability)** —— DeepSeek Harness 宿主级插件，把 **Skill 与 MCP 服务器**变成"可视、可管、可注入"的统一目录。

- **MCP**：三档（eager 原生注册 / on-demand 桥 / disabled），模型工具面三件套 `mcp_register` / `mcp_load(peek)` / `mcp_call`，pre-step `mcp-catalog` 注入，boot 导入并接管原生 `dsh-mcp-client` 条目。
- **Skill**：递归扫描 `customRecursiveDirs`（任意深度只认 `<dir>/SKILL.md`），frontmatter 启停、跨平台删除、系统编辑器打开、shipped 只读护栏。

## 目录结构

```
lib/index.js    宿主主模块：MCP 三件套、连接/快照、导入接管、reconcile、预热、catalog 注入、UI RPC handlers
lib/skill.js    递归 skill provider + frontmatter 编辑（setDisableModelInvocation）
lib/ui.js       HTTP 路由 + /skills /mcp 命令 + 跨平台 open/trash + 密钥打码 + entryView
client/client.js 浏览器端（__ModuleLoader__.load 单文件 bundle，纯 JS React）
test/*.mjs      单元/冒烟测试（基线全绿：node test/*.mjs）
docs/           设计（DESIGN.zh.md）、交接（HANDOFF.md）、截图
```

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
- `~/.dsh/profiles/<profile>/cordis.patch.yml` —— 被 reconcile 的 patch：托管块（MANAGED_MARKER 之后）= 影子条目 + 原生条目 `disabled:true` 接管行。

### 每次启动顺序（lib/index.js 的 apply → startup）

1. `loadRegistry(dataDir)`
2. 读 settings.json（覆盖 `toolDescriptionMaxLength`）
3. `importNative()` —— 解析 patch 原生段，把 registry 没有的 `dsh-mcp-client` 条目入库（默认 on-demand；原生 disabled 则 disabled）
4. `reconcile()` —— 写托管块：registry-only 条目写 `disabled:true` 影子 insert + 每个启用原生行追加 `- id: X\n  disabled: true` 覆盖行（接管）
5. eager 条目 `ensureEager`（连接 + 注册 `mcp__<server>__<tool>`）
6. `warmSnapshots()` —— 无缓存或 `metaFetchedAt` 为空的条目并发连接、抓工具快照 + 服务器元信息

## 关键设计决策（改动前务必遵守）

- **on-demand 桥 = 前缀零失效**：on-demand 条目不注册原生 schema，模型只看到 `mcp_load/mcp_call/mcp_register`。eager 才原生注册。
- **名称语义**：`entry.name`（本地名）= 模型命名空间，必须 `[A-Za-z0-9_-]{1,32}`（拼进 `mcp__<name>__<tool>`）；`entry.serverName`（服务器自报名）= 只读元信息，来自 `serverInfo.name`，可与本地名不同。
- **本地 `description` 已删除**：描述完全来自服务器自报 `serverDescription`；`mcp_register` 无 `description` 参数。`notes` 是用户维护，永不被覆盖。
- **元信息字段**：`serverName / serverVersion / serverTitle / serverDescription / websiteUrl / instructions / capabilities / metaFetchedAt`，由 `applyServerMetadata(entry, connection)` 在连接时填充，只读。
- **导入接管 = 两阶段靠档位规避**：默认 on-demand 不注册原生工具，所以「导入 + 写 disabled」能在同一次 boot 完成、无重名冲突；若某条目被用户切成 eager，才回到「关原生防重名」语义（依赖接管行已写好）。
- **shipped 技能只读**：路径含 `node_modules` 或 `app.asar` 的技能（如 cordis preset 的）只能查看/打开，禁止启停/删除（`isReadonlySkillPath`）。
- **只 append/替换托管块**：`reconcile` 从 `MANAGED_MARKER` 起整段重写，用户原生段（marker 之前）byte-for-byte 保留；写前 `.bak-<ts>` 备份。
- **目录注入 digest 驱动**：`catalogDigest` 含 serverDescription + 工具名/描述；变了才重新注入（追加替换，不改历史）。

## 编码约定

- **纯 JavaScript**：Host 与 Client 都不经过 TS/JSX/bundler 转换。Client 用 `React.createElement(...)`，**禁止 JSX / TypeScript / import / require**（client.js 里唯一的外部依赖是 `require("react")`）。
- 模块为 ESM（`type: module`）。
- 错误处理：handler 抛错 → 路由层统一 `400 {ok:false,error}`；拒绝/校验失败用 `throw`，不用返回 `{ok:false}` 的 200。

## 开发 / 测试 / 安装

```bash
# 依赖
pnpm install --config.auto-install-peers=true

# 语法检查
node --check lib/index.js lib/skill.js lib/ui.js client/client.js

# 测试基线（全绿）
node test/smoke.mjs            # 三件套 + 命令注册
node test/schema-check.mjs     # 工具 schema 校验
node test/skill-smoke.mjs      # 递归 provider
node test/watcher-smoke.mjs    # watcher 热生效
node test/import-smoke.mjs     # 原生导入 + 接管（隔离 DSH_HOME，勿连真实网络）
node test/ui-smoke.mjs         # HTTP 路由 + 只读护栏 + ctx.inject 路径
node test/frontmatter-smoke.mjs# frontmatter 启停写入

# 重装进 desktop profile（file: 依赖要 remove+add 才刷新）
cd ~/.dsh/profiles/desktop
pnpm remove dsh-skill-mcp-manager
pnpm add "file:D:/Github/dsh-skill-mcp-manager"
# 然后重启 DSH
```

## 常见坑

- **测试不能碰真实 profile**：测试里 `profile` 用 `"__test__"`（不存在）且 `importNativeMcp: false`，否则 `importNative`/`reconcile` 会读写真实 `~/.dsh/profiles/web|desktop/cordis.patch.yml`（历史上污染过一次）。
- **import-smoke 的 MCP URL 用本地死端口**（`http://127.0.0.1:1/`）：预热会尝试连接，别让它真连外部服务。
- **前端加了新的 GET+POST 同 path 路由**：必须合并成单条 handler（见上文）。
- **新增配置项**：记得同步 `Config` schema、`cordis.patch.example.yml`、README 配置表。
