# Tide one-click installer.
# Detects/installs Node.js, installs npm deps, prepares .env, creates a desktop
# shortcut, and opens the web console. Designed to run without admin rights.

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$root       = Split-Path -Parent $PSScriptRoot          # project root (parent of tools/)
$nodeDir    = Join-Path $root 'tools\node'              # portable Node target
$minNode    = 20                                        # minimum major version

function Write-Step  ($m) { Write-Host "`n>> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "   [OK] $m" -ForegroundColor Green }
function Write-Info  ($m) { Write-Host "   $m" -ForegroundColor Gray }
function Write-Warn2 ($m) { Write-Host "   [!] $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. Resolve a usable Node.js (PATH -> portable -> download portable)
# ---------------------------------------------------------------------------
function Get-NodeMajor {
    param([string]$NodeExe = 'node')
    try {
        $v = & $NodeExe -v 2>$null            # e.g. v22.13.1
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        return [int]($v.TrimStart('v').Split('.')[0])
    } catch { return $null }
}

function Install-PortableNode {
    Write-Step 'Node.js 未满足要求，下载便携版（无需管理员权限）...'

    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

    Write-Info '正在向 nodejs.org 查询最新 LTS 版本...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts   = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (-not $lts) { throw '无法确定 Node.js LTS 版本。' }
    $ver   = $lts.version                                    # vXX.YY.ZZ
    $name  = "node-$ver-win-$arch"
    $url   = "https://nodejs.org/dist/$ver/$name.zip"

    $tmp = Join-Path $env:TEMP "tide-node-$ver"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp "$name.zip"

    Write-Info "下载 $url"
    $oldPref = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $ProgressPreference = $oldPref

    Write-Info '解压中...'
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $nodeDir -Parent) -Force | Out-Null
    Move-Item -Path (Join-Path $tmp $name) -Destination $nodeDir -Force
    Remove-Item $tmp -Recurse -Force

    Write-Ok "便携版 Node $ver 已安装到 tools\node"
}

Write-Step '检测 Node.js'
$usePortable = $false

$major = Get-NodeMajor 'node'
if ($major -ne $null -and $major -ge $minNode) {
    Write-Ok ("使用系统 Node.js v{0}.x" -f $major)
}
elseif ((Test-Path (Join-Path $nodeDir 'node.exe')) -and `
        ((Get-NodeMajor (Join-Path $nodeDir 'node.exe')) -ge $minNode)) {
    Write-Ok '使用已安装的便携版 Node.js (tools\node)'
    $usePortable = $true
}
else {
    Install-PortableNode
    $usePortable = $true
}

# Make the chosen Node visible to npm in this process.
if ($usePortable) { $env:PATH = "$nodeDir;$env:PATH" }

$nodeVer = & node -v
$npmVer  = & npm -v
Write-Info "node $nodeVer / npm v$npmVer"

# ---------------------------------------------------------------------------
# 2. Install npm dependencies
# ---------------------------------------------------------------------------
Write-Step '安装依赖 (npm install)'
Push-Location $root
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败 (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Ok '依赖安装完成'

# ---------------------------------------------------------------------------
# 2b. 注册全局 tide 命令 (npm link) —— 尽力而为，失败不影响网页/一键启动
# ---------------------------------------------------------------------------
Write-Step '注册全局 tide 命令 (npm link)'
Push-Location $root
try {
    & npm link
    if ($LASTEXITCODE -eq 0) {
        Write-Ok '已注册：在任意目录的终端输入 tide 即可启动命令行界面'
    } else {
        Write-Warn2 'npm link 失败（可跳过；网页与一键启动不受影响）'
    }
} catch {
    Write-Warn2 "npm link 失败：$($_.Exception.Message)（可跳过）"
} finally {
    Pop-Location
}
if ($usePortable) {
    Write-Info '注意：使用便携版 Node 时，tide 命令可能不在系统 PATH 上；网页/一键启动照常可用。'
}

# ---------------------------------------------------------------------------
# 3. Prepare .env (keep existing; otherwise copy example with API keys blanked)
# ---------------------------------------------------------------------------
Write-Step '准备配置文件 .env'
$envPath     = Join-Path $root '.env'
$examplePath = Join-Path $root '.env.example'

if (Test-Path $envPath) {
    Write-Ok '.env 已存在，保留你现有的配置（不覆盖）'
}
elseif (Test-Path $examplePath) {
    $out = foreach ($line in (Get-Content -LiteralPath $examplePath)) {
        if ($line -match '^[A-Z0-9_]*API_KEY\s*=') { ($line -replace '=.*$', '=') }
        else { $line }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($envPath, $out, $utf8NoBom)
    Write-Ok '.env 已生成（API Key 留空，稍后在网页里填写）'
}
else {
    Write-Warn2 '未找到 .env.example，跳过 .env 生成'
}

# ---------------------------------------------------------------------------
# 4. 在项目文件夹内创建一键启动快捷方式（不再放到桌面）
# ---------------------------------------------------------------------------
Write-Step '在项目文件夹内创建一键启动快捷方式'
$vbsLauncher = Join-Path $root 'tools\Tide.vbs'
if (Test-Path $vbsLauncher) {
    try {
        # 清理旧的桌面快捷方式（如果之前版本创建过）
        $oldDesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Tide 控制台.lnk'
        if (Test-Path $oldDesktopLnk) { Remove-Item $oldDesktopLnk -Force -ErrorAction SilentlyContinue }

        # 快捷方式指向 wscript + Tide.vbs：后端隐藏托管，只弹一个应用窗口，零黑窗口闪烁。
        $lnkPath  = Join-Path $root '一键启动 Tide.lnk'
        $shell    = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($lnkPath)
        $shortcut.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
        $shortcut.Arguments        = """$vbsLauncher"""
        $shortcut.WorkingDirectory = $root
        $shortcut.Description       = 'Tide 本地 Agent 控制台（单窗口，前端托管后端）'
        $shortcut.IconLocation      = "$env:SystemRoot\System32\shell32.dll,13"
        $shortcut.Save()
        Write-Ok "一键启动快捷方式已创建：$lnkPath"
    } catch {
        Write-Warn2 "创建快捷方式失败：$($_.Exception.Message)"
    }
} else {
    Write-Warn2 '未找到 tools\Tide.vbs，跳过快捷方式创建'
}

# ---------------------------------------------------------------------------
# 5. Launch the web console
# ---------------------------------------------------------------------------
Write-Step '打开 Tide 控制台网页'
Write-Info '浏览器将自动打开控制台。首次使用请在网页左侧的“模型 API 设置”里选择供应商并填写 API Key。'
Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList """$vbsLauncher""" -WorkingDirectory $root

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "  - 网页控制台：双击项目里的 “一键启动 Tide”（或 Start Tide.cmd）" -ForegroundColor Green
Write-Host "  - 命令行界面：在任意目录的终端输入  tide" -ForegroundColor Green
Write-Host "  - 终端技巧：运行中按 ESC 可中断当前任务；支持整段多行粘贴" -ForegroundColor Green
Write-Host "============================================================`n" -ForegroundColor Green
