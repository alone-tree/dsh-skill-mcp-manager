# 续接指引（下一个会话从这里开始）

> 给下个会话的完整上下文。新会话第一步：读本文件 + `docs/DESIGN.zh.md`，再看 `lib/` 源码。

## 项目概况

- **仓库**：`D:\Github\dsh-skill-mcp-manager`（git，12 commits，main 干净）
- **插件**：`dsh-skill-mcp-manager` — DSH 宿主级插件，管理 **Skill** 与 **MCP**
- **设计文档**：`docs/DESIGN.zh.md`（§1-13 全量，含 20 条已定决策 + 端到端流程）
- **安装位置**：本机 `desktop` profile（`~/.dsh/profiles/desktop`），`file:` 依赖

## 已完成（后端，全部真机验证过）

| 里程碑 | 内容 |
|---|---|
| M0 | `registry.json` + `mcp_register`/`mcp_load(peek)`/`mcp_call` 三件套 + pre-step `mcp-catalog` 注入 + 三档 eager/on-demand/disabled + AB 通道（eager 原生注册、on-demand 走桥） |
| M1 | 递归 skill provider（任意深度只认 `<dir>/SKILL.md`，含根入口）+ frontmatter 解析 + **watcher 热生效**（改 skill 不用重启） |
| M2 | 回写 reconcile（往 `cordis.patch.yml` 写 `disabled: true` 影子条目）+ `/prepare-uninstall` 命令（交还原生 dsh-mcp-client） |
| M3 | Client 管理页：Skill 启停/打开/删除，MCP 档位/详情/密钥/刷新快照/删除，以及同源 HTTP RPC |
| 单工具禁用 | `disabledTools` 黑名单；新工具默认启用；管理页逐工具“启用/禁用”下拉框；目录/load 隐藏 + eager/bridge 双调用边界拒绝 |
| 会话隔离 | 每个 DSH 会话（含子代理）独立 MCP 实例；eager 注册到 `agent.ctx`；管理页无已连接/断开 |
| 全量合并接管 | 吸收（全文扫描、按行 id 认领）→ 托管块整体重生成（每条目一行 disabled，重复 id 拒绝写盘）→ 托管块外被认领行移除；本机真机验证：6 条原生行全部收编，端到端可用 |

- 现有 Host 侧模块：`lib/index.js`（MCP 三件套 + 注入 + reconcile + 单工具黑名单 + UI handlers）、`lib/skill.js`（递归 provider + watcher）、`lib/ui.js`（同源 HTTP 路由和文件操作）。
- 现有 Client：`client/client.js`，在 `settings.section` 注册“能力库”，包含技能/MCP 两个标签页。
- `inject = ["tools", "skills"]`；`ctx.get("commands")` 可选注册 `/prepare-uninstall`。

## 当前状态

- MCP 运行实例已按会话隔离；配置仍全局共享。后续按 `IDEAS.md` 中未定想法继续迭代。
- 真机验证（2026-08-31）：思源桥双会话各自独立进程、并发读取不同文档互不干扰，子代理实例随会话自动回收；父会话浏览器页面不被子代理覆盖。已知边界：playwright 默认持久 profile 全机单例，第二会话并行用浏览器需在该条目加 `--isolated`（MCP 配置项，未改）。
- MCP 单工具禁用的安全边界：禁用工具不注册/不注入/不由 `mcp_load` 返回；即使模型记住旧名称，eager `execute` 与 `mcp_call` 仍会在发出 MCP 调用前拒绝。
- 禁用不取消已经开始执行的调用。`mcp_register` 不开放黑名单修改参数，只有管理 UI 能修改。
- **1.1.3（2026-09-07，未发版）**：`mcp_call` 参数形状守卫 + 工具调用错误附上下文（桥 + eager 双路径，含协议错误与 `isError` 结果两类）。**真机验证全部通过（2026-09-07，desktop profile）**：① eager 原生直调正常（tavily 实测，工具面即时可用、无需重启会话、无需先 `mcp_load`）；② eager `isError` 上下文（`tavily_extract` 缺 `urls` 实测，报错带 `called MCP tool` + `arguments sent`）；③ **协议层错误上下文**（本地临时 stdio server 的 handler 直接 throw → SDK 返回 -32603 实测，报错三段齐全：原始错误 + called MCP tool + arguments sent + tool inputSchema；验证后条目已禁用、临时脚本已删）；④ 桥接失败上下文（未知工具名实测，按设计不附 inputSchema）；⑤ `mcp_call` 缺 `tool` 守卫分支。双路径 × 两类错误形态全部真机覆盖，无遗留。
- **真机实测发现（重要）**：DSH 宿主会对未通过工具 schema `required` 校验的调用先清洗参数再传给 handler，嵌套内容到不了 handler。含义：① 插件不能假设宿主会替自己做参数校验；② 守卫的嵌套形状识别分支在真实宿主下是防御性冗余（mock 直调 handler 可达）；③ issue #1 的根因（`{tool,args}` 原样透传成 `params.name=undefined`）是旧宿主+旧插件组合下的现象。

- **1.1.3 补充（2026-09-07 同日落地）**：`mcp_load` 与工具快照补回 `inputSchema`——修复 M0 起 `snapshotTools` 把工具裁剪成 `{name, description}`，导致 load/peek/registry 永不含参数结构、与工具 description"parameter schemas"自相矛盾的问题（`renderDefinitions` 的 schema 渲染分支一直是死分支）。真机已验证：重启后 peek 返回逐工具完整 schema。测试 `test/mcp-load-schema-smoke.mjs` 入发布基线。

## 开发 / 测试 / 安装

```bash
# 依赖（本地开发）
cd D:\Github\dsh-skill-mcp-manager
pnpm install --config.auto-install-peers=true

# 跑自动化测试（发布基线 = AGENTS.md 的显式清单；不要用 node test/*.mjs，
# 其中 e2e-playwright.mjs 需要真实运行时、不属于基线）
node test/smoke.mjs
node test/schema-check.mjs
node test/skill-smoke.mjs
node test/watcher-smoke.mjs
node test/import-smoke.mjs
node test/ui-smoke.mjs
node test/frontmatter-smoke.mjs
node test/catalog-smoke.mjs
node test/tool-disable-smoke.mjs
node test/session-isolate-smoke.mjs
node test/mcp-call-guard-smoke.mjs
node test/mcp-load-schema-smoke.mjs

# 重装进 desktop（改完代码后，pnpm 对 file: 依赖要 remove+add 才刷新）
cd C:\Users\Zinger\.dsh\profiles\desktop
pnpm remove dsh-skill-mcp-manager
pnpm add "file:D:/Github/dsh-skill-mcp-manager"
# 然后重启 DSH

# 语法检查
node --check lib/index.js
node --check lib/skill.js
```

## 关键事实 / 坑

- **profile 是 `desktop`，不是 `web`**（`profile-selection/state.json` → `"active": "desktop"`）。
- **dsh-plugin-manager（liqichen）已卸载**，只留我们的 manager + `dshmarket`（市场）+ `dsh-find-plugin`（`find_dsh_plugin` 工具）。
- 数据目录：`~/.dsh/skill-mcp-manager/`（`registry.json` + `settings.json`，`settings.json.customRecursiveDirs = ["D:\\HermesSync\\global-skills"]`）。
- playwright MCP 当前以 on-demand 档在 registry 里，desktop `cordis.patch.yml` 末尾有其 `disabled: true` 影子条目。
- pnpm 对 `file:` 依赖会缓存，改版本号或 remove+add 才刷新（本项目用 remove+add）。
- `cordis.patch.yml` 是 HMR 热生效的（`watchUserPatches`）；改它会立即重组合，写错 YAML 会让整个树加载失败（但旧树继续跑）。

## 参考源码模式（已对齐）

- `dsh-mcp-client`（MCP SDK 客户端 + 工具注册）、`dsh-tool-skill`（pre-step 注入 + 命令）、`dsh-command-compact`（命令注册）、`dsh-skill-filesystem`（frontmatter 解析）。
- 这些都在 `C:\Users\Zinger\AppData\Local\Programs\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\` 下。
