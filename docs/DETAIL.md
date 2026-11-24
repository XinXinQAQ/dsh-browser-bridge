# DSH 浏览器桥接

让 DeepSeek Harness 通过本机的 WorkBuddy 浏览器扩展控制 Chrome / Edge。

## 工作方式

- DSH 启动 `native-host.mjs`（MCP stdio 模式），在本地 TCP 端口 18765 上提供桥接服务。
- Chrome / Edge 中的 WorkBuddy 扩展通过原生消息宿主 `com.workbuddy_ai.extension` 启动同一脚本的 `--native` 模式，把扩展协议转发到该 TCP 桥。
- MCP 工具以 `mcp__browser__*` 命名，安装后自动出现在模型的工具列表中。

## 使用流程

1. 先调用 `browser_status` 确认扩展已连接。
2. 用 `browser_open` 新建标签页，或用 `browser_tabs` 列出并用 `browser_claim` 认领已有标签页。记下返回的 `tabId` 与 `generation`。
3. 用 `browser_navigate`、`browser_screenshot`、`browser_dom`、`browser_click`、`browser_type`、`browser_key` 等操作。每个操作都要传 `tabId` 和 `generation`。
4. 结束时调用 `browser_finish` 释放标签页。

## 前提

- 已安装并启用 WorkBuddy 浏览器扩展。
- 原生消息宿主 `com.workbuddy_ai.extension` 已注册并指向本目录的 `native-host.mjs`（安装时通过 `install.ps1` 完成）。
- Node.js 22+ 在 `C:\Program Files\nodejs\node.exe`。
