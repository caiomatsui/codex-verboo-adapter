[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$projectRoot = $PSScriptRoot
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
  # Retry a few times; if it still fails, keep the committed verboo.json so
  # Codex can still start.
  $catalogJson = $null
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      $catalogJson = Invoke-RestMethod -Uri "http://127.0.0.1:$port/catalog" -Method Get -TimeoutSec 20
      break
    } catch {
      Write-Warning "Could not fetch the live model catalog (attempt $($attempt + 1)/3): $($_.Exception.Message)"
      if ($attempt -lt 2) { Start-Sleep -Seconds 1 }
    }
  }
  if ($catalogJson -and $catalogJson.models.Count -gt 0) {
    [System.IO.File]::WriteAllText($catalogPath, ($catalogJson | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  } else {
    Write-Warning 'Using the committed model catalog (verboo.json) because the live catalog is unavailable.'
  }

  # Plan-adaptive default: the adapter resolves it (deepseek-v4-flash when the
  # plan includes it, otherwise the first available model for the key).
  $defaultModel = 'deepseek-v4-flash'
  try {
    $defaultModel = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/catalog/default-model" -Method Get -TimeoutSec 10).default_model
  } catch {
    Write-Warning "Could not resolve the default model ($($_.Exception.Message)); using 'deepseek-v4-flash'."
  }
  Write-Host "Verboo Codex adapter ready - default model: $defaultModel (use /model to switch)"

  $env:CODEX_HOME = $PSScriptRoot
  & codex `
    -c "model_catalog_json='$catalogPath'" `
    -c "model='$defaultModel'" `
    -c "model_provider='verboo'" `
    -c "model_providers.verboo.base_url='http://127.0.0.1:$port/v1'" `
    -c "model_providers.verboo.name='Verboo Code (local Responses adapter)'" `
    @CodexArgs
  exit $LASTEXITCODE
} finally {
  if ($proxyProcess -and -not $proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id -Force
  }
}
