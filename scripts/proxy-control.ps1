<#
.SYNOPSIS
  Start, stop, and check the local proxies the free council seats depend on.

.DESCRIPTION
  Two council seats talk to a process on localhost rather than to a metered
  API: `free-claude` (Free Claude Code, port 8082) and `openrouter-free` (the
  OpenRouter free-model proxy in proxies/openrouter-free, port 8080). Both fail
  loudly when nothing is listening - deliberately, because a silent fallback
  would spend a paid subscription. So the launcher starts them rather than
  depending on anyone remembering to.

  Two properties this script has to get right, both learned the hard way:

  * Readiness is not "the port is open". A proxy that is listening but has an
    empty model catalogue answers every request with a failure. Readiness here
    means health AND a non-empty catalogue.

  * Ownership is not a PID. PIDs are reused, and killing a reused PID kills
    something innocent. Ownership is recorded as PID plus process start ticks,
    and a mismatch refuses to stop anything. A proxy you started by hand is
    left alone.

.PARAMETER Proxy
  Which proxy to act on: 'fcc' or 'openrouter-free'.

.PARAMETER Action
  start | stop | status | restart | owner

.PARAMETER OwnerPid
  With -Action owner: the PID whose liveness is being checked.

.PARAMETER OwnerStarted
  With -Action owner: that process's start ticks, so a reused PID is not
  mistaken for the original.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('fcc', 'openrouter-free')]
  [string]$Proxy,

  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'status', 'restart', 'owner')]
  [string]$Action,

  [int]$OwnerPid = 0,
  [string]$OwnerStarted = '',

  # Directory the proxy lives in. Defaults to the matching environment
  # variable, which dsh-env.cmd sets.
  [string]$Dir = '',

  # Where ownership markers and logs are kept.
  [string]$StateDir = '',

  [int]$Port = 0
)
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Per-proxy definitions. Everything that differs between the two proxies lives
# here; the logic below is shared.
# ---------------------------------------------------------------------------
$Definitions = @{
  'fcc' = @{
    Label      = 'Free Claude'
    DirEnv     = 'FCC_DIR'
    Port       = 8082
    # FCC's own entry point, run from the virtualenv it was installed into.
    Python     = '.venv\Scripts\python.exe'
    Arguments  = @('-c', '"from free_claude_code.cli.entrypoints import serve; serve()"')
    # Without this every start opens the Admin UI in a browser tab.
    Env        = @{ FCC_OPEN_BROWSER = 'false' }
    HealthPath = '/health'
    ModelsPath = '/v1/models'
  }
  'openrouter-free' = @{
    Label      = 'OpenRouter Free'
    DirEnv     = 'ORFREE_DIR'
    Port       = 8080
    Python     = '.venv\Scripts\python.exe'
    Arguments  = @('-m', 'openrouter_proxy')
    # This proxy takes its bind address on the command line, so -Port has to
    # reach the process and not only the health check.
    PortArgs   = { param($p) @('--host', '127.0.0.1', '--port', "$p") }
    Env        = @{}
    HealthPath = '/health'
    ModelsPath = '/v1/models'
    # Free models are billed at zero, not served anonymously: the catalogue
    # call still needs a key, and without one the proxy exits immediately.
    KeyEnv     = 'OPENROUTER_API_KEY'
  }
}

$def = $Definitions[$Proxy]
$Label = $def.Label
if ($Port -eq 0) { $Port = $def.Port }
if ([string]::IsNullOrWhiteSpace($Dir)) {
  $Dir = [Environment]::GetEnvironmentVariable($def.DirEnv)
}
if ([string]::IsNullOrWhiteSpace($StateDir)) {
  $StateDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $StateDir)) {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

$MarkerPath = Join-Path $StateDir "$Proxy-owned.json"
$LogPath    = Join-Path $StateDir "$Proxy-monitor.log"
$OutPath    = Join-Path $StateDir "$Proxy-server.stdout.log"
$ErrPath    = Join-Path $StateDir "$Proxy-server.stderr.log"
$Base       = "http://127.0.0.1:$Port"

function Write-Status([string]$Message) {
  Write-Output $Message
  Add-Content -LiteralPath $LogPath -Value "$([DateTime]::UtcNow.ToString('o')) $Message"
}

# Listening is not ready: a proxy with an empty catalogue answers every
# request with a failure. Both conditions, or it does not count.
function Test-Ready {
  try {
    $health = Invoke-RestMethod "$Base$($def.HealthPath)" -TimeoutSec 2
    if ($health.status -ne 'healthy') { return $false }
    $models = Invoke-RestMethod "$Base$($def.ModelsPath)" -TimeoutSec 2
    return ($models.object -eq 'list' -and $null -ne $models.data -and @($models.data).Count -gt 0)
  } catch { return $false }
}

function Test-Port {
  $client = New-Object Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $Port); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

function Stop-Owned {
  if (-not (Test-Path -LiteralPath $MarkerPath)) { return }
  $record = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
  $ownedProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if ($ownedProcess) {
    # Never kill a reused PID or a server started by somebody else.
    if ($ownedProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.started) {
      throw "$Label ownership does not match the live process; refusing to stop it."
    }
    # /T because the server is a process tree: killing the parent alone leaks
    # the worker that actually holds the port, and the port stays bound.
    & taskkill.exe /PID $record.pid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the owned $Label process tree." }
  }
  Remove-Item -LiteralPath $MarkerPath
}

# The key is read from the environment first, then from DSH's own credential
# file, so a proxy authenticates the same way every other caller on this
# machine does and there is no second copy to keep in step.
function Resolve-Key([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { return $value }
  $credentials = Join-Path $StateDir '.credentials.yaml'
  if (Test-Path -LiteralPath $credentials) {
    foreach ($line in Get-Content -LiteralPath $credentials) {
      if ($line.Trim().StartsWith($name)) {
        return $line.Split(':', 2)[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return $null
}

function Start-Proxy {
  if (Test-Ready) { Write-Status "$Label ready (health and model catalog verified)."; return $true }
  if (Test-Port) {
    Write-Status "$Label unavailable: port $Port is occupied but readiness failed. See $ErrPath."
    return $false
  }
  Stop-Owned
  if ([string]::IsNullOrWhiteSpace($Dir)) {
    Write-Status "$Label not configured: set $($def.DirEnv) in dsh-env.cmd, or leave the seat disabled."
    return $false
  }
  if (-not (Test-Path -LiteralPath $Dir)) { throw "$Label directory does not exist: $Dir" }
  $python = Join-Path $Dir $def.Python
  if (-not (Test-Path -LiteralPath $python)) { throw "$Label Python environment is missing: $python" }

  foreach ($pair in $def.Env.GetEnumerator()) {
    Set-Item -Path "env:$($pair.Key)" -Value $pair.Value
  }
  if ($def.ContainsKey('KeyEnv')) {
    $key = Resolve-Key $def.KeyEnv
    if (-not $key) {
      Write-Status "$Label not started: no $($def.KeyEnv). Set it, or store it in $(Join-Path $StateDir '.credentials.yaml')."
      return $false
    }
    Set-Item -Path "env:$($def.KeyEnv)" -Value $key
  }

  $arguments = @($def.Arguments)
  if ($def.ContainsKey('PortArgs')) { $arguments += & $def.PortArgs $Port }

  Write-Status "$Label starting hidden; waiting up to 60 seconds for readiness."
  $child = Start-Process -FilePath $python -ArgumentList $arguments `
    -WorkingDirectory $Dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $OutPath -RedirectStandardError $ErrPath
  @{pid = $child.Id; started = $child.StartTime.ToUniversalTime().Ticks.ToString()} |
    ConvertTo-Json | Set-Content -LiteralPath $MarkerPath

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Ready) { Write-Status "$Label ready (health and model catalog verified)."; return $true }
    if ($child.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Stop-Owned
  Write-Status "$Label unavailable: startup failed. See $ErrPath and $OutPath."
  return $false
}

if ($Action -eq 'owner') {
  $ownerProcess = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
  if ($ownerProcess -and $ownerProcess.StartTime.ToUniversalTime().Ticks.ToString() -eq $OwnerStarted) { exit 0 }
  exit 1
}
if ($Action -eq 'status') {
  if (Test-Ready) { Write-Output "$Label ready (health and model catalog verified)."; exit 0 }
  Write-Output "$Label unavailable."
  exit 1
}

# Serialize starts/recovery/stop across launcher invocations.
$mutex = New-Object Threading.Mutex($false, "Local\DSH-Proxy-$Proxy")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(65000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw "Another $Label controller is busy." }
  if ($Action -eq 'stop') { Stop-Owned; exit 0 }
  if ($Action -eq 'restart') {
    if (Test-Ready) { exit 0 }
    Stop-Owned
  }
  # Capture only the final boolean; emit status messages separately.
  $result = @(Start-Proxy)
  $result | Select-Object -SkipLast 1 | ForEach-Object { Write-Output $_ }
  if ($result[-1] -eq $true) { exit 0 }
  exit 1
} catch {
  Write-Status "$Label unavailable: $($_.Exception.Message)"
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
