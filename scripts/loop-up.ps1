# loop-up.ps1 - Start/stop/status for the spec-driven loop (L1/L2/L3).
#
# Modes:
#   New (default) : Full pipeline. L1 reads inbox → drafts, L2 builds, L3 evolves.
#   Continue      : Skip L1. L2 picks up highest unbuilt evolve-N, L3 reviews.
#   Stop          : Kill all running daemons.
#   Status        : Report which daemons are alive and on which ports.
#
# Requires: bun, opencode installed (npm global), agent-loop project root as CWD.
# Space-path safe: uses -LiteralPath throughout.
param(
    [ValidateSet('New','Continue','Stop','Status')][string]$Mode = 'Continue',
    [string]$Idea = ''   # for Mode=New: optional idea to seed the inbox
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$bunCmd = "C:\Users\azizm\AppData\Roaming\npm\bun.cmd"

if (-not (Test-Path -LiteralPath $bunCmd)) {
    Write-Error "bun.cmd not found at $bunCmd - install bun or update the path"
    exit 1
}

# ─── PID helpers ─────────────────────────────────────────────────────────────
$pidFiles = @{
    L1 = Join-Path $root 'daemon-l1.pid'
    L2 = Join-Path $root 'daemon-l2.pid'
    L3 = Join-Path $root 'daemon-l3.pid'
}
$errFiles = @{
    L1 = Join-Path $root 'daemon-l1-3001.err'
    L2 = Join-Path $root 'daemon-l2-3002.err'
    L3 = Join-Path $root 'daemon-l3-3003.err'
}
$logFiles = @{
    L1 = Join-Path $root 'daemon-l1-3001.log'
    L2 = Join-Path $root 'daemon-l2-3002.log'
    L3 = Join-Path $root 'daemon-l3-3003.log'
}
$plans = @{
    L1 = 'plans/spec-creator.yaml'
    L2 = 'plans/spec-executor.yaml'
    L3 = 'plans/spec-evolve.yaml'
}
$ports = @{ L1 = 3001; L2 = 3002; L3 = 3003 }
$crons = @{ L1 = '*/15 * * * *'; L2 = '17 3 * * *'; L3 = '17 3 * * *' }

function Get-LoopPid ([string]$Label) {
    $f = $pidFiles[$Label]
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    $pidStr = (Get-Content -LiteralPath $f -Raw).Trim()
    if (-not $pidStr) { return $null }
    $proc = Get-Process -Id $pidStr -ErrorAction SilentlyContinue
    return $proc
}

function Kill-LoopDaemon ([string]$Label) {
    $proc = Get-LoopPid $Label
    if (-not $proc) { Write-Host "  ${Label}: not running"; return }
    # Kill both the cmd parent and the bun child
    $children = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $proc.Id }
    foreach ($c in $children) {
        Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  ${Label}: stopped (PID $($proc.Id))"
}

function Start-LoopDaemon ([string]$Label) {
    $plan  = $plans[$Label]
    $port  = $ports[$Label]
    $cron  = $crons[$Label]
    $log   = $logFiles[$Label]
    $err   = $errFiles[$Label]
    $pidF  = $pidFiles[$Label]
    $fullPlan = Join-Path $root $plan

    Write-Host ("  ${Label}: starting on port $port ($plan)")

    # Use a quoted single-arg string so the cron expression survives shell splitting.
    $argsStr = 'run loop.ts daemon --plan "' + $fullPlan + '" --port ' + $port + ' --cron "' + $cron + '"'

    $proc = Start-Process -FilePath $bunCmd -ArgumentList $argsStr `
        -RedirectStandardOutput $log -RedirectStandardError $err `
        -NoNewWindow -PassThru
    $proc.Id | Out-File -FilePath $pidF -NoNewline
}

# ─── Status mode ─────────────────────────────────────────────────────────────
if ($Mode -eq 'Status') {
    Write-Host ""
    Write-Host "=== Spec Loop Status ==="
    $specsDir = "D:\projects\obsidian\second brain\10-Projects\11-Active\parallel loops\spec-factory\specs"
    Write-Host ("Loop root: $root")
    Write-Host ""
    foreach ($label in @('L1','L2','L3')) {
        $proc = Get-LoopPid $label
        $plan = $plans[$label]
        $err  = $errFiles[$label]
        if ($proc) {
            $lastErr = if (Test-Path -LiteralPath $err) {
                $e = Get-Content -LiteralPath $err -Tail 2
                if ($e) { $e[-1].Trim() } else { '(no err line)' }
            } else { '(no err file)' }
            Write-Host ("  $label  RUNNING  PID=$($proc.Id)  port=$($ports[$label])  " + $lastErr)
        } else {
            Write-Host ("  $label  STOPPED")
        }
    }
    Write-Host ""
    if (Test-Path -LiteralPath $specsDir) {
        $ev = @(Get-ChildItem -LiteralPath $specsDir -File -Filter 'evolve-*.md' -ErrorAction SilentlyContinue)
        $bu = @(Get-ChildItem -LiteralPath $specsDir -File -Filter 'built-*' -ErrorAction SilentlyContinue)
        Write-Host ("Specs: $($ev.Count) evolve-N.md files, $($bu.Count) built-N stamps")
        foreach ($e in $ev) {
            $n = if ($e.Name -match 'evolve-(\d{3})') { $matches[1] } else { '?' }
            $stamped = Test-Path (Join-Path $specsDir "built-$n")
            Write-Host ("  $($e.Name)  $(if($stamped){'BUILT'}else{'UNBUILT'})")
        }
    }
    exit 0
}

# ─── Stop mode ───────────────────────────────────────────────────────────────
if ($Mode -eq 'Stop') {
    Write-Host "Stopping spec loop daemons..."
    Kill-LoopDaemon 'L1'
    Kill-LoopDaemon 'L2'
    Kill-LoopDaemon 'L3'
    Write-Host "All daemons stopped."
    exit 0
}

# ─── Start (New or Continue) ────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Spec Loop  up ==="
Write-Host "Mode: $Mode"
if ($Mode -eq 'New' -and $Idea) {
    $inbox = "D:\projects\obsidian\second brain\10-Projects\11-Active\parallel loops\spec-factory\specs\ideas\inbox.md"
    $inboxDir = Split-Path -Parent $inbox
    if (-not (Test-Path -LiteralPath $inboxDir)) { New-Item -ItemType Directory -Path $inboxDir -Force | Out-Null }
    Add-Content -LiteralPath $inbox -Value "`n$Idea" -Encoding UTF8 -NoNewline
    Write-Host "  Idea seeded in inbox: $Idea"
}

# Kill any stale daemons first for clean restart.
Kill-LoopDaemon 'L1'
Kill-LoopDaemon 'L2'
Kill-LoopDaemon 'L3'
Start-Sleep -Seconds 2

$env:LOOP_DAILY_RUN_CAP = "1000"

Set-Location -LiteralPath $root

if ($Mode -eq 'New') {
    Start-LoopDaemon 'L1'
}
Start-LoopDaemon 'L2'
Start-LoopDaemon 'L3'

Start-Sleep -Seconds 5

# Verify they started.
Write-Host ""
Write-Host "=== Health check ==="
foreach ($label in @('L1','L2','L3')) {
    if ($Mode -eq 'Continue' -and $label -eq 'L1') { continue }
    $proc = Get-LoopPid $label
    if ($proc) {
        Write-Host ("  $label  OK  (PID $($proc.Id), port $($ports[$label]))")
    } else {
        Write-Host ("  $label  FAILED TO START")
    }
}
Write-Host ""
Write-Host "Dashboard: http://localhost:3001 (L1), http://localhost:3002 (L2), http://localhost:3003 (L3)"
Write-Host "Stop:      /loop stop  or  powershell -File scripts/loop-up.ps1 -Stop"
Write-Host "Status:    /loop status  or  powershell -File scripts/loop-up.ps1 -Status"
Write-Host "Logs:      $root\daemon-*.log / daemon-*.err"
Write-Host ""
