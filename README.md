# DSH Browser Bridge

让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 通过 WorkBuddy 浏览器扩展操作你正在用的 Chrome / Edge：导航、截图、读取可见 DOM、点击、输入、滚动，登录态和 Cookie 保留在浏览器内。

## 原理

WorkBuddy 浏览器扩展通过 Chrome Native Messaging 连接一个原生宿主。本插件把这个通道桥接成 MCP 工具供 DSH 调用：

```
DSH ── mcp__browser__* (stdio MCP) ──> native-host.mjs (MCP server / broker)
                                          │ 持有 TCP 127.0.0.1:18765
                                          │ 跟踪所有 native host，选用最新 READY 的那个
                                          ^ TCP 连接
浏览器 ── Native Messaging ──> native-host.mjs --native (TCP client)
                                          │ 扩展协议 (4字节长度前缀 JSON)
                                          v
                              WorkBuddy 浏览器扩展 ──> 真实标签页
```

**为什么 broker 架构**：DSH 侧的 MCP 进程持有监听端口，浏览器中拉起的 native host 只作为客户端连入。这样浏览器重启 / 扩展重载 / 多个 native host 实例时，新的 native host 只要完成握手就自动接管，不会像旧架构那样被僵尸进程的端口占用卡死。native host 在扩展断开（stdin end/error/close）或租约过期时主动退出，broker 通过 heartbeat 追踪就绪状态。

## 前置条件

- Windows + Node.js 18+
- Chrome 或 Edge
- 已安装并启用 WorkBuddy 浏览器扩展（扩展 ID 需在原生宿主 `allowed_origins` 中，脚本已内置三个已知 ID）

## 安装

1. 克隆本仓库到本地，例如 `C:\Users\<你>\dsh-browser-bridge`。
2. 以普通用户权限运行：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   脚本会：把运行时脚本复制到 `~\.dsh\browser-bridge`（纯 ASCII 路径，避免中文路径破坏 .cmd wrapper）、注册 Chrome/Edge 原生消息宿主、按本机路径生成 `cordis.patch.yml`。
3. 在 DSH 中安装此目录为插件：**Plugins → Add plugin → 选择本目录**；或让 DSH 执行：
   ```
   plugin_manager install_bundle  target=<本目录绝对路径>
   ```
4. 重启浏览器（让扩展重新连接原生宿主），确认插件行 `dsh-browser-bridge` 处于 active。

## 使用

DSH 会获得 14 个 `mcp__browser__*` 工具。典型流程：

1. `browser_status` — 确认扩展已连接。
2. `browser_open`（URL）新建标签，或 `browser_tabs` → `browser_claim` 认领已有标签。记下返回的 `tabId` 和 `generation`。
3. 操作：`browser_navigate` / `browser_screenshot` / `browser_dom` / `browser_click` / `browser_scroll` / `browser_type` / `browser_key` / `browser_dom_click` / `browser_close_tab`。每次都要带 `tabId` 和 `generation`。
4. `browser_finish` — 结束会话，释放租约。

> 页面导航后 `generation` 会变化，需要重新 `browser_tabs(controlled=true)` 获取最新值。

## 工具一览

| 工具 | 说明 |
|---|---|
| `browser_status` | 连接状态、浏览器能力、受控标签 |
| `browser_open` | 新建标签并导航 |
| `browser_tabs` | 列出可认领/已受控标签 |
| `browser_claim` | 认领用户标签 |
| `browser_navigate` | 导航到 URL |
| `browser_screenshot` | 截图（返回 base64 图片） |
| `browser_dom` | 可见 DOM 快照（含 node_id） |
| `browser_click` | 按视口坐标点击 |
| `browser_scroll` | 滚动 |
| `browser_type` | 输入文本 |
| `browser_key` | 按键/组合键 |
| `browser_dom_click` | 按 node_id 点击 |
| `browser_close_tab` | 关闭受控标签 |
| `browser_finish` | 释放会话租约 |

## 目录结构

```
.
├── native-host.mjs          # 桥接核心（--native=对接扩展，默认=MCP server）
├── install.ps1              # 一键安装（注册原生宿主 + 生成 cordis.patch.yml）
├── cordis.patch.yml         # DSH MCP client 插件配置（install.ps1 会按本机路径覆盖）
├── package.json             # bundle 清单
├── locale/                  # 插件展示元数据（中/英）
├── docs/DETAIL.md           # 插件详情页
└── icon.svg                 # 插件图标
```

## 自定义

- 端口：默认 `18765`，通过环境变量 `DSH_BROWSER_BRIDGE_PORT` 修改（wrapper 和 cordis.patch 需一致）。
- 扩展 ID：如扩展 ID 变化，更新 `install.ps1` 中的 `$extIds`。
- 日志：设置 `DSH_BROWSER_BRIDGE_LOG=<文件路径>` 输出桥接日志便于排查。

## License

MIT
