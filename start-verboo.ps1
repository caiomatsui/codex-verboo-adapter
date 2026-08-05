[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$proxyPath = Join-Path $PSScriptRoot 'verboo-responses-proxy.mjs'
$catalogPath = Join-Path $PSScriptRoot 'verboo.json'

if (-not $env:VERBOO_API_KEY -and (Test-Path -LiteralPath $envFile)) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*VERBOO_API_KEY\s*=\s*(.+?)\s*$') {
      $env:VERBOO_API_KEY = $matches[1].Trim('"', "'")
      break
    }
  }
}

if (-not $env:VERBOO_API_KEY) {
  throw 'VERBOO_API_KEY is not set. Add it to .env (which is ignored by Git) or set it for this shell session.'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$proxyProcess = Start-Process -FilePath 'node' -ArgumentList @($proxyPath, '--port', $port) -PassThru -NoNewWindow
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 1
      if ($health.status -eq 'ok') { $ready = $true; break }
    } catch {
      if ($proxyProcess.HasExited) { throw 'The Verboo Codex adapter exited before it became ready.' }
    }
  }
  if (-not $ready) { throw 'Timed out while starting the Verboo Codex adapter.' }

  # Fetch the live model catalog from the adapter (built from the Verboo /models
  # endpoint for the pasted API key) so /model lists every available model.
  $catalogJson = Invoke-RestMethod -Uri "http://127.0.0.1:$port/catalog" -Method Get -TimeoutSec 20
  $catalogJson | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $catalogPath -Encoding UTF8

  $env:CODEX_HOME = $PSScriptRoot
  & codex `
    -c "model_catalog_json='$catalogPath'" `
    -c "model='deepseek-v4-flash'" `
    -c "model_provider='verboo'" `
    -c "model_providers.verboo.base_url='http://127.0.0.1:$port/v1'" `
    @CodexArgs
  exit $LASTEXITCODE
} finally {
  if ($proxyProcess -and -not $proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id -Force
  }
}
