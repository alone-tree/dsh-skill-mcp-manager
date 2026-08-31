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
| M3 | Client 管理页：Skill 启停/打开/删除，MCP 档位/详情/密钥/加载/断开/删除，以及同源 HTTP RPC |
| 单工具禁用 | `disabledTools` 黑名单；新工具默认启用；管理页逐工具“启用/禁用”下拉框；目录/load 隐藏 + eager/bridge 双调用边界拒绝 |

- 现有 Host 侧模块：`lib/index.js`（MCP 三件套 + 注入 + reconcile + 单工具黑名单 + UI handlers）、`lib/skill.js`（递归 provider + watcher）、`lib/ui.js`（同源 HTTP 路由和文件操作）。
- 现有 Client：`client/client.js`，在 `settings.section` 注册“能力库”，包含技能/MCP 两个标签页。
- `inject = ["tools", "skills"]`；`ctx.get("commands")` 可选注册 `/prepare-uninstall`。

## 当前状态

- 已实现设计文档中的 Host、Client 管理功能；后续按 `IDEAS.md` 中未定想法继续迭代。
- MCP 单工具禁用的安全边界：禁用工具不注册/不注入/不由 `mcp_load` 返回；即使模型记住旧名称，eager `execute` 与 `mcp_call` 仍会在发出 MCP 调用前拒绝。
- 禁用不取消已经开始执行的调用。`mcp_register` 不开放黑名单修改参数，只有管理 UI 能修改。

## 开发 / 测试 / 安装

```bash
# 依赖（本地开发）
cd D:\Github\dsh-skill-mcp-manager
pnpm install --config.auto-install-peers=true

# 跑自动化测试（全绿基线）
node test/*.mjs
# 单工具禁用专项
node test/tool-disable-smoke.mjs

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
