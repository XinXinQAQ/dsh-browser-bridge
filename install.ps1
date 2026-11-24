<#
.SYNOPSIS
  一键安装 DSH Browser Bridge：注册原生消息宿主 + 安装 DSH bundle。
.DESCRIPTION
  在任意 Windows 机器上运行：把运行时脚本放到用户目录（纯 ASCII 路径，避免
  Chrome 原生消息宿主 .cmd wrapper 的中文路径问题），注册 Chrome/Edge 原生宿主，
  生成指向本机的 cordis.patch.yml，然后用 DSH 的 plugin_manager 安装 bundle。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
$ErrorActionPreference = 'Stop'

$hostName   = 'com.workbuddy_ai.extension'
$runtimeDir = Join-Path $env:USERPROFILE '.dsh\browser-bridge'
$nodeExe    = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  $candidate = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path $candidate) { $nodeExe = $candidate }
}
if (-not $nodeExe) { throw '未找到 node.exe。请先安装 Node.js 18+ 并确保在 PATH 中。' }

# 扩展允许的来源（WorkBuddy 浏览器扩展的三个已知 ID）
$extIds = @(
  'chrome-extension://ajnnogdfpilbhkeggdjlcokgglijmdde/',
  'chrome-extension://kkjblpnnljnmbhaaakgcmfioipgamgii/',
  'chrome-extension://ndbfelmlimfjklodckmbalfioaehegpc/'
)

Write-Host "== DSH Browser Bridge 安装 ==" -ForegroundColor Cyan
Write-Host "Node: $nodeExe"
Write-Host "Runtime dir: $runtimeDir"

if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null }
Copy-Item -Path (Join-Path $PSScriptRoot 'native-host.mjs') -Destination (Join-Path $runtimeDir 'native-host.mjs') -Force

# wrapper 必须是纯 ASCII 路径；若用户目录含非 ASCII 字符，退回短路径或报错提示
$script = Join-Path $runtimeDir 'native-host.mjs'
$wrapper = Join-Path $runtimeDir 'native-host.cmd'
@"
@echo off
"$nodeExe" "$script" --native %*
"@ | Set-Content -Path $wrapper -Encoding ASCII

# 原生消息宿主 manifest
$manifestPath = Join-Path $runtimeDir "$hostName.json"
$manifest = @{
  name = $hostName
  description = 'DSH browser bridge native host'
  path = $wrapper
  type = 'stdio'
  allowed_origins = $extIds
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

# 注册到 Chrome / Edge
$bases = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
foreach ($base in $bases) {
  if (-not (Test-Path $base)) { New-Item -Path $base -Force | Out-Null }
  $key = Join-Path $base $hostName
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "已注册: $base\$hostName"
}

# 生成本机 cordis.patch.yml（转义 node 路径与脚本路径）
$nodeEsc = $nodeExe -replace '\\', '\\\\'
$scriptEsc = $script -replace '\\', '\\\\'
$patch = @"
- insert:
    - id: dsh-browser-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: '$nodeEsc'
        args:
          - '$scriptEsc'
        env:
          DSH_BROWSER_BRIDGE_PORT: '18765'
        toolCallTimeoutMs: 90000
        startupTimeoutMs: 15000
        reconnect:
          enabled: true
          initialDelayMs: 1000
          maxDelayMs: 15000
          maxAttempts: 20
"@
$patch | Set-Content -Path (Join-Path $PSScriptRoot 'cordis.patch.yml') -Encoding UTF8
Write-Host "已生成 cordis.patch.yml"

Write-Host ""
Write-Host "原生消息宿主已就绪。" -ForegroundColor Green
Write-Host "接下来在 DSH 里安装此插件目录：Plugins > Add plugin > 选择本目录。" -ForegroundColor Green
Write-Host "或者让 DSH 执行: plugin_manager install_bundle，target = $PSScriptRoot"
Write-Host ""
Write-Host "注意：需先在 Chrome/Edge 安装并启用 WorkBuddy 浏览器扩展。" -ForegroundColor Yellow
