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

- 现有 Host 侧模块：`lib/index.js`（MCP 三件套 + 注入 + reconcile + prepare-uninstall 命令）、`lib/skill.js`（递归 provider + watcher）。
- `inject = ["tools", "skills"]`；`ctx.get("commands")` 可选注册 `/prepare-uninstall`。

## 待做（Client UI，唯一剩余）

1. **SKILL 管理抽屉**：frontmatter 启停 Switch（写 `disable-model-invocation`）、跨平台删除（回收站）、系统编辑器打开（`start`/`open`/`xdg-open`）。
2. **MCP 管理抽屉**：档位切换（eager/on-demand/disabled）、删除条目、详情、密钥打码。
3. **入口**：`sidebar.footer.action` + `/skills`、`/mcp` 命令。

对应设计文档：§4.2/§4.3/§4.4（skill 管理）、§7（UI Slots）、§5.10-4（删除条目 = registry+patch 整条删）。

## 开 UI 前必须先查（用 cordis_inspect）

- `Slots.listSubTree` → `settings.section`、`sidebar.footer.action` 的确切注册契约和 props。
- Host↔Client RPC：查 `ctx.remote` / `harness.handle` / `host.call` 的确切 API（Client→Host，仅 lossless JSON）。
- Client 组件：React `createElement`，禁止 JSX/TS（插件源码是纯 JS，无打包转换）。

## 后端服务现状（Client 要接的）

- Host 已有：递归 provider（`ctx.skills.registerProvider`）、reconcile、三件套工具。但 **frontmatter 启停/删除/系统编辑器打开还没有实现**（设计里是 UI 触发，不是模型工具）。
- 需要新增：Host 侧 RPC 方法（启停/删除/打开/档位切换/删除条目），Client 抽屉调这些 RPC。

## 开发 / 测试 / 安装

```bash
# 依赖（本地开发）
cd D:\Github\dsh-skill-mcp-manager
pnpm install --config.auto-install-peers=true

# 跑测试（5 个，全绿基线）
node test/smoke.mjs            # 三件套 + 命令注册
node test/schema-check.mjs     # 工具 schema 校验
node test/skill-smoke.mjs      # 递归 provider
node test/watcher-smoke.mjs    # watcher 热生效
node test/count-skills.mjs     # 应扫出 119 个技能

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
