# Tide launcher.
# Ensures the backend is running hidden (no console window), then opens the web
# UI in the default browser and exits. The backend keeps running in the
# background; closing the tab just closes the page. Use the exit button in the
# UI (POST /api/quit) to fully stop the backend.
# Pure ASCII on purpose (Chinese Windows console encoding pitfalls).

$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:TIDE_PORT) { [int]$env:TIDE_PORT } else { 8787 }
$base = "http://127.0.0.1:$port"

# Resolve Node: prefer the portable copy bundled by the installer, else PATH.
$portableNode = Join-Path $root 'tools\node\node.exe'
$node = if (Test-Path $portableNode) { $portableNode } else { 'node' }
$tsxCli = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
$server = Join-Path $root 'src\server.ts'

function Test-Backend {
    try {
        Invoke-WebRequest "$base/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# 1. Make sure the backend is up. Start it hidden if needed and wait until ready.
if (-not (Test-Backend)) {
    $procArgs = @($tsxCli, $server, '--port', "$port")
    Start-Process -FilePath $node -ArgumentList $procArgs -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Backend) { break }
        Start-Sleep -Milliseconds 500
    }
}

# 2. Open the UI in the default browser, then exit.
Start-Process $base | Out-Null
