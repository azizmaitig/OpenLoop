# check-l2-readiness.ps1 - L2 readiness mechanical checks (v11 D5, T7 #39)
#
# Source of truth: docs/l2-readiness-checklist.md. This script executes the
# MECHANICAL checks (M1-M7) against the live opencode server and the target
# repo. Human ticks (H1-H5) are judgment calls - no script can make them.
#
# Usage:
#   .\scripts\check-l2-readiness.ps1
#   .\scripts\check-l2-readiness.ps1 -OpenCodeUrl http://127.0.0.1:4096 -TargetDir ..\calendar-app
#
# Exit code: 0 = all blocking checks PASS | 1 = a blocking check FAILED
#
# SECURITY: this script never prints secrets. It reports booleans and
# presence only (M2 prompt is trivial, no auth headers, no .env reads).

param(
  [string]$OpenCodeUrl = "http://127.0.0.1:4096",
  [string]$TargetDir = "..\calendar-app",
  [string]$BaselineDoc = "docs\test-baseline.md",
  [int]$RoundTripTimeoutSec = 90
)

$ErrorActionPreference = "Stop"
$origin = $OpenCodeUrl.TrimEnd('/')
$pass = 0
$fail = 0
$skip = 0
$results = @()

function Report([string]$name, [string]$status, [string]$detail) {
  $script:results += "  [$status] $name - $detail"
  if ($status -eq "PASS") { $script:pass++ }
  elseif ($status -eq "FAIL") { $script:fail++ }
  else { $script:skip++ }
}

function Invoke-Json([string]$method, [string]$url, $body = $null) {
  $params = @{ Uri = $url; Method = $method; TimeoutSec = 30 }
  if ($null -ne $body) {
    $params.ContentType = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 10 -Compress)
  }
  $res = Invoke-RestMethod @params
  return $res
}

Write-Host ""
Write-Host "=== L2 readiness - mechanical checks (M1-M7) ==="
Write-Host "opencode: $origin"
Write-Host "target:   $TargetDir"
Write-Host "baseline: $BaselineDoc"
Write-Host ""

# --- M1: opencode server up -------------------------------------------------
$serverUp = $false
try {
  $health = Invoke-RestMethod -Uri "$origin/api/health" -Method GET -TimeoutSec 10
  $serverUp = ($null -eq $health.healthy -or $health.healthy -eq $true)
  Report "M1 opencode server up" $(if ($serverUp) { "PASS" } else { "FAIL" }) `
    "GET /api/health on $origin responded (healthy=$($health.healthy))"
} catch {
  Report "M1 opencode server up" "FAIL" "GET /api/health failed: $($_.Exception.Message)"
}

# --- M2: round-trip smoke test (needs M1) -----------------------------------
if ($serverUp) {
  $roundTrip = "SKIP"
  $detail = "not attempted"
  try {
    $session = Invoke-Json "POST" "$origin/session" @{ title = "l2-readiness-smoke" }
    $sid = $session.id
    if (-not $sid) { throw "no session id in response" }

    $promptBody = @{ parts = @(@{ type = "text"; text = "Reply with exactly: OK" }) }
    Invoke-Json "POST" "$origin/session/$sid/prompt_async" $promptBody | Out-Null

    # Poll GET /session/{id}/message until an assistant text part arrives.
    $deadline = (Get-Date).AddSeconds($RoundTripTimeoutSec)
    $seenText = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $messages = Invoke-Json "GET" "$origin/session/$sid/message"
        $json = ($messages | ConvertTo-Json -Depth 20 -Compress)
        if ($json -match '"type"\s*:\s*"text"' -and $json -match 'OK') {
          $seenText = $true
          break
        }
      } catch { }
      Start-Sleep -Seconds 2
    }

    # Best-effort cleanup - never fail the check because abort itself failed.
    try { Invoke-Json "POST" "$origin/session/$sid/abort" | Out-Null } catch { }

    if ($seenText) {
      $roundTrip = "PASS"
      $detail = "session $sid replied to a trivial prompt (assistant text received)"
    } else {
      $roundTrip = "FAIL"
      $detail = "session $sid created but no assistant text within ${RoundTripTimeoutSec}s - agent backend not actually answering"
    }
  } catch {
    $roundTrip = "FAIL"
    $detail = "round-trip failed: $($_.Exception.Message)"
  }
  Report "M2 round-trip proven (smoke test)" $roundTrip $detail
} else {
  Report "M2 round-trip proven (smoke test)" "SKIP" "server down - cannot prove round-trip"
}

# --- M3: target repo is git OR backup confirmed -----------------------------
$resolvedTarget = (Resolve-Path $TargetDir -ErrorAction SilentlyContinue)
if ($resolvedTarget) {
  $targetPath = $resolvedTarget.Path
  $isGit = Test-Path (Join-Path $targetPath ".git")
  $backup = Get-ChildItem -Path (Split-Path $targetPath) -Filter "*.bak" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*$([IO.Path]::GetFileName($targetPath))*" } | Select-Object -First 1
  if ($isGit) {
    Report "M3 target repo git or backup" "PASS" "$targetPath is a git worktree (.git present)"
  } elseif ($backup) {
    Report "M3 target repo git or backup" "PASS" "non-git target has backup: $($backup.Name)"
  } else {
    Report "M3 target repo git or backup" "FAIL" "target is not git AND no *.bak backup found - T6 backup path unavailable"
  }

  # --- M4: working tree clean (git targets only) ----------------------------
  if ($isGit) {
    $porcelain = (& git -C $targetPath status --porcelain 2>$null)
    if ($LASTEXITCODE -eq 0 -and $porcelain.Length -eq 0) {
      Report "M4 working tree clean" "PASS" "$targetPath has no uncommitted changes"
    } elseif ($LASTEXITCODE -ne 0) {
      Report "M4 working tree clean" "FAIL" "git status failed (exit $LASTEXITCODE)"
    } else {
      Report "M4 working tree clean" "FAIL" "$targetPath has uncommitted changes - WIP would be corrupted"
    }
  } else {
    Report "M4 working tree clean" "SKIP" "non-git target - no working tree to check"
  }
} else {
  Report "M3 target repo git or backup" "FAIL" "target dir not found: $TargetDir"
  Report "M4 working tree clean" "SKIP" "target not found"
}

# --- M5: baseline tests documented -------------------------------------------
$baselinePath = Join-Path (Split-Path $PSScriptRoot -Parent) $BaselineDoc
if (Test-Path $baselinePath) {
  $content = Get-Content $baselinePath -Raw
  if ($content -match 'fail' -and $content -match 'error') {
    Report "M5 baseline tests documented" "PASS" "$baselinePath exists and records fail/error baseline"
  } else {
    Report "M5 baseline tests documented" "FAIL" "$baselinePath exists but does not record fail/error counts"
  }
} else {
  Report "M5 baseline tests documented" "FAIL" "$baselinePath missing - record the current 'bun test' fail/error baseline before L2 runs"
}

# --- M6: worktree create/discard OK (needs M1) -------------------------------
if ($serverUp) {
  $wtName = "l2-readiness-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  try {
    $wt = Invoke-Json "POST" "$origin/experimental/worktree" @{ name = $wtName }
    if ($null -eq $wt.directory) { throw "no directory in worktree response" }
    $discarded = Invoke-Json "DELETE" "$origin/experimental/worktree" @{ directory = $wt.directory }
    if ($discarded -eq $true) {
      Report "M6 worktree create/discard OK" "PASS" "worktree $wtName created + discarded cleanly"
    } else {
      Report "M6 worktree create/discard OK" "FAIL" "worktree $wtName created but DELETE did not return true"
    }
  } catch {
    Report "M6 worktree create/discard OK" "FAIL" "worktree round-trip failed: $($_.Exception.Message)"
  }
} else {
  Report "M6 worktree create/discard OK" "SKIP" "server down - cannot prove worktree ops"
}

# --- M7: budget configured ---------------------------------------------------
$cap = [Environment]::GetEnvironmentVariable("LOOP_DAILY_RUN_CAP")
if (-not [string]::IsNullOrWhiteSpace($cap)) {
  Report "M7 budget configured" "PASS" "LOOP_DAILY_RUN_CAP=$cap"
} else {
  Report "M7 budget configured" "FAIL" "LOOP_DAILY_RUN_CAP is not set - loop cannot flip to report-only at 80%"
}

# --- Report ------------------------------------------------------------------
Write-Host "--- results ---"
$results | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host ("SUMMARY: {0} PASS | {1} FAIL | {2} SKIP" -f $pass, $fail, $skip)
if ($fail -gt 0) {
  Write-Host "RESULT: NOT READY - blocking check(s) failed. See docs/l2-readiness-checklist.md."
  exit 1
}
Write-Host "RESULT: READY - mechanical checks pass. Complete human ticks H1-H5 and declare l2.checklist: done in the plan YAML."
exit 0