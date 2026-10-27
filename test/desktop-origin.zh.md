# Desktop「刷新快照」回归测试

目标：Desktop 的 `dsh-app://app` 请求经过桌面壳转发后，即使没有
`Origin` / `Sec-Fetch-Site`，管理页仍能刷新 MCP 工具列表；不放宽跨站请求保护。

## 测试层次

| 方法 | 命令 / 入口 | 覆盖范围 |
| --- | --- | --- |
| 路由安全回归 | `node test/security-smoke.mjs` | 同源、Desktop 标记、JSON、Host、跨站、空/错误 Origin、预检拒绝 |
| 实际客户端 bundle | `node test/ui-smoke.mjs` | 在最小 React 宿主里运行发布用 bundle，点击保存，验证 POST 头及设置落盘；不是 GUI 渲染测试 |
| 会话回归 | `node test/session-isolate-smoke.mjs` | Web / Desktop 刷新工具与 schema，不复用或破坏会话实例 |
| 无 GUI 集成（可移植） | `node test/desktop-origin-smoke.mjs` | 模拟桌面请求头转换，真实 loopback HTTP → 插件路由 → stdio MCP 子进程 → 注册表 |
| 无 GUI 集成（已安装桌面壳） | 下方 `--desktop-asar` 命令 | 直接执行安装包里的 `forwardWebRequest`，其余链路同上 |
| GUI 手动验收 | 下方操作步骤 | 实际 Desktop 页面、前端 bundle、运行中的 Host、刷新按钮与可见工具列表 |

无 GUI 测试都不能代替最后一项。现有 `e2e-playwright.mjs` 验证的是模型调用
Playwright MCP 的桥接，不是自动点击 Desktop 的 GUI 测试，也不属于发布基线。

## 一、无 GUI：干净检出的自动化回归

从仓库根目录运行，先按 `AGENTS.md` 安装开发依赖（CI 使用 Node.js 24）：

```sh
node test/security-smoke.mjs
node test/ui-smoke.mjs
node test/session-isolate-smoke.mjs
node test/desktop-origin-smoke.mjs
```

新增集成测试使用 `test/fixtures/desktop-origin-server.mjs`，仅提供
`desktop_ping` 工具，不需要账号、token 或外部 MCP 服务。插件设置为
`profile: "__test__"`、`importNativeMcp: false`，并在动态导入插件前将
`DSH_HOME` 指向独立临时目录（模块导入时就会保存这个路径）；
注册表也写入同一临时根目录。仅靠测试 profile 名称不足以隔离 `reconcile()`。
HTTP 只监听 `127.0.0.1` 随机端口。结束时关闭连接/子进程并删除临时目录，
不读取或修改真实 profile、注册表和会话。需要允许本地监听与启动 Node 子进程；
若环境禁止这些能力，测试失败，不将跳过计作通过。

断言包括：

1. 外站 Origin 在转发前被拒绝，Host 未收到请求。
2. Desktop POST 没有专用标记时返回 `403 / untrusted origin`，旧快照保持不变。
3. 加上 `x-dsh-skill-mcp-manager: 1` 后返回 `200 / ok: true`。
4. 预置的 `stale` 工具真正被 `desktop_ping` 替换，完整 `inputSchema` 与服务器名称落盘。
5. Host 实际收到的请求没有 Origin / Sec-Fetch-Site，但保留专用标记。

成功输出含 `PASS Desktop snapshot: portable forwarding contract (no Electron)`。
恢复旧版 Host 的 Origin 守卫后，第 3 项必须失败（实际 403、预期 200）；
这验证测试能检出原故障，而非只验证测试夹具。

完整发布基线见 `AGENTS.md` 和 `.github/workflows/publish.yml` 的显式命令清单，
新增集成测试也在其中。不要使用 `node test/*.mjs` 代替该清单。

## 二、无 GUI：使用本机真实 Desktop 转发函数

提供**自己信任的本机安装包**路径，Windows 示例：

```powershell
node test/desktop-origin-smoke.mjs --desktop-asar 'D:/dsh/resources/app.asar'
```

换成实际安装目录即可。测试直接读取 ASAR 的 `package.json` 与 `lib/main.js`，
提取并执行 `forwardWebRequest` 所在段，不需要安装 ASAR CLI、不解包整个应用，
也不会启动/关闭 Desktop 或连接它的真实 Host。使用的是测试专用 HTTP Host、
虚拟 cookie 和本地 MCP 夹具，不读取用户 cookie / token。

成功输出会包含真实包名与版本，例如：

```text
PASS Desktop snapshot: installed @deepseek-ai/dsh-desktop@0.2.1-rc.3; HTTP + stdio + persisted tools/schema
```

这是桌面壳转发函数的集成验证，**没有启动 Electron，也没有验证 GUI 点击**。
读取的源代码会执行；`vm` 不是安全沙箱，不要传入下载来路不明的 ASAR。
提取逻辑以 `0.2.1-rc.3` 的打包结构验证；未来版本改了路径或代码段结构时测试会
明确失败，需先检查新实现再调整测试，不能静默回退到可移植模式并宣称真机通过。

## 三、GUI 手动验收

### 安装确认

1. 记录操作系统、Desktop 版本、插件 commit / 安装来源、测试时间。
2. 将包含修复的 PR commit 或本地源码安装进实际使用的 profile，安装方法见
   `AGENTS.md`。仅修改 checkout 不会更新 profile 里的 npm / Git / `file:` 副本。
3. 确认运行位置的 `client/client.js` 和 `lib/ui.js` 均与待测源码一致。
   Windows 可对这两个文件分别使用 `Get-FileHash` 比较源码与
   `<profile>/node_modules/dsh-skill-mcp-manager/` 内副本的 SHA256。
4. 正常退出 Desktop（不是只关窗口到托盘），重新启动，重新打开能力库 MCP 页面。
   只刷新页面可能仍使用旧 Host；只更换 Host 文件也可能仍运行旧前端。

### 准备一个已知可用的 MCP

可使用已有、凭证正确且至少提供一个工具的 MCP。为了排除远端账号或网络问题，
也可以在单独的测试 profile 中注册仓库自带的无凭证 stdio 夹具。
让 DSH 调用 `mcp_register`，参数如下，路径替换为本机绝对路径：

```json
{
  "name": "desktop_origin_test",
  "tier": "on-demand",
  "transport": "stdio",
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/src/dsh-skill-mcp-manager/test/fixtures/desktop-origin-server.mjs"],
  "cwd": "C:/src/dsh-skill-mcp-manager",
  "env": {}
}
```

仓库需已安装依赖。注册本地程序需遵守当前 profile 的本地命令审批设置，
不要为了测试关闭审批。注册本身也可能预先取到快照，因此**不能把注册成功或
已有工具列表当成刷新按钮通过**；必须执行后续点击步骤。该可选 GUI 操作会向
选定 profile 注册测试条目，与前两节自动化的完全隔离模式不同。

### 点击与验收

1. 在 Desktop 打开能力库的 **MCP** 页面，找到目标条目并展开。
2. 点击 **刷新快照**，等待本次操作结束，确认没有 `untrusted origin` 提示。
3. 确认本次刷新显示成功，工具数量/列表与服务器一致。使用夹具时应显示
   `desktop_ping`（1 个工具），展开后可查看工具描述与参数 schema。
4. 再次点击刷新，确认仍成功；离开 MCP 页面再返回，确认快照仍可读取。
5. 记录结果和脱敏截图/错误信息。使用临时夹具时，从管理页删除测试条目。

如果仍报 `untrusted origin`，先检查安装确认中的文件一致性和完整重启，再检查
Host 是否收到标记头。若错误变成 MCP 服务端的 401/403、token 或
`Authorization header is badly formatted`，说明需另查 MCP 凭证格式；
它不是同一个来源守卫错误，且**不能因为不再报 Origin 就把整项 GUI 验收记为成功**。
只有刷新成功且工具列表可用才算通过。报告不要包含 token、cookie 或原始认证头。

## 验证记录（2026-10-27）

- 环境：Windows，Node.js `v26.5.0`；安装包内 Desktop
  `@deepseek-ai/dsh-desktop@0.2.1-rc.3`。
- 修复 commit：`52e31951c573570f40e86659a4660b5712919072`；本次只补充测试与说明。
- 无 GUI：可移植 HTTP + stdio + 快照落盘，以及从本机 ASAR 执行真实转发函数，
  均由开发侧运行验证。完整发布基线同步运行。
- **GUI 手动测试成功：问题报告者确认**，实际应用修复并更正其自身 MCP 配置后，
  确认项目修复有效。此前错误配置引起的认证报错不计作 GUI 成功记录。
  这条记录来自报告者在真实 Desktop 中的验收；不声称自动化驱动了 GUI，
  也不把上述可选本地夹具流程记成已完成的 GUI 实测。
