[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$projectRoot = $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$proxyPath = Join-Path $PSScriptRoot 'verboo-responses-proxy.mjs'
$fallbackCatalogPath = Join-Path $PSScriptRoot 'verboo.json'

# Dedicated, git-ignored runtime folder. All Codex state (sqlite/logs/sessions)
# and the regenerated catalog live here, so the adapter never pollutes the
# folder it is installed in and never touches a user's existing .codex/config.
$runtimeDir = Join-Path $projectRoot 'codex-verboo-runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$catalogPath = Join-Path $runtimeDir 'verboo.json'
$configPath = Join-Path $runtimeDir 'config.toml'

# Reasoning level new conversations start at. --effort <level> wins, then
# VERBOO_REASONING_EFFORT, then xhigh. Verboo levels are none/low/medium/high/
# xhigh/max; "max" is Verboo's highest level and appears in Codex under
# /model -> "More reasoning..." -> Advanced Reasoning -> Max.
$requestedEffort = $env:VERBOO_REASONING_EFFORT
if (-not $requestedEffort) { $requestedEffort = 'xhigh' }

# Pull --effort/--reasoning-effort out of the Codex arguments so they configure
# the session instead of being forwarded to Codex (which has no such flag).
$forwardArgs = @()
for ($i = 0; $i -lt $CodexArgs.Count; $i++) {
  $arg = $CodexArgs[$i]
  if ($arg -eq '--effort' -or $arg -eq '--reasoning-effort') {
    if ($i + 1 -ge $CodexArgs.Count) { throw "$arg requires a value (none, low, medium, high, xhigh or max)." }
    $requestedEffort = $CodexArgs[$i + 1]
    $i++
    continue
  }
  if ($arg -like '--effort=*') { $requestedEffort = $arg.Substring(9); continue }
  if ($arg -like '--reasoning-effort=*') { $requestedEffort = $arg.Substring(19); continue }
  $forwardArgs += $arg
}
$requestedEffort = $requestedEffort.Trim().ToLowerInvariant()
if (@('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') -notcontains $requestedEffort) {
  Write-Warning "'$requestedEffort' is not a known reasoning level; passing it through so Verboo can validate it."
}

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

# The proxy reads this to decide each model's default reasoning level in the
# catalog, so it must be set before the proxy starts (Start-Process inherits it).
$env:VERBOO_REASONING_EFFORT = $requestedEffort

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

  # Fetch the live model catalog (all models for the key). Retry a few times;
  # if it still fails, fall back to the committed verboo.json so Codex starts.
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
    $catalogPath = $fallbackCatalogPath
  }

  # Plan-adaptive default: deepseek-v4-flash-0731 when available, else first model.
  $defaultModel = 'deepseek-v4-flash-0731'
  try {
    $defaultModel = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/catalog/default-model" -Method Get -TimeoutSec 10).default_model
  } catch {
    Write-Warning "Could not resolve the default model ($($_.Exception.Message)); using 'deepseek-v4-flash-0731'."
  }

  # Provider config for this session. Written after the model, effort and port
  # are known so the file always matches how Codex is actually launched.
  $configText = @(
    '# Generated by codex-verboo on every launch. Lives in the git-ignored runtime folder.'
    'approval_policy = ' + [char]34 + 'on-request' + [char]34
    'approvals_reviewer = ' + [char]34 + 'auto_review' + [char]34
    'model = ' + [char]34 + $defaultModel + [char]34
    'model_reasoning_effort = ' + [char]34 + $requestedEffort + [char]34
    "[model_providers.verboo]"
    "name = " + [char]34 + "Verboo Code (local Responses adapter)" + [char]34
    "base_url = " + [char]34 + "http://127.0.0.1:$port/v1" + [char]34
    "env_key = " + [char]34 + "VERBOO_API_KEY" + [char]34
    "wire_api = " + [char]34 + "responses" + [char]34
    "request_max_retries = 1"
    "stream_max_retries = 1"
    "stream_idle_timeout_ms = 7200000"
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText($configPath, $configText, [System.Text.UTF8Encoding]::new($false))

  Write-Host "Verboo Codex adapter ready - model: $defaultModel - reasoning: $requestedEffort (use /model to switch)"

  $env:CODEX_HOME = $runtimeDir
  # Default to --approve-for-me (auto-review), unless the caller already
  # passed an approval-mode flag that conflicts with it (e.g. --yolo /
  # --dangerously-bypass-approvals-and-sandbox) or passed --approve-for-me itself.
  $approveFlag = @('--approve-for-me')
  foreach ($arg in $forwardArgs) {
    if ($arg -eq '--dangerously-bypass-approvals-and-sandbox' -or $arg -eq '--yolo' -or $arg -eq '--approve-for-me') {
      $approveFlag = @()
      break
    }
  }
  $allCodexArgs = $approveFlag + $forwardArgs
  & codex `
    -c "model_catalog_json='$catalogPath'" `
    -c "model='$defaultModel'" `
    -c "model_reasoning_effort='$requestedEffort'" `
    -c "model_provider='verboo'" `
    -c "model_providers.verboo.base_url='http://127.0.0.1:$port/v1'" `
    -c "model_providers.verboo.name='Verboo Code (local Responses adapter)'" `
    @allCodexArgs
  exit $LASTEXITCODE
} finally {
  if ($proxyProcess -and -not $proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id -Force
  }
}
