# l3-should-evolve.ps1 -- L3 evolve-pass combo-trigger (ADR-0019 §3/§4).
#
# Cheap pre-check that runs BEFORE the LLM propose step (Issue 4). Pure
# PowerShell: reads loop-run-log.md and decides WAKE (propose) vs IDLE
# (no proposal). Never calls `opencode` -- zero LLM cost, no false failure.
#
# The log grammar it consumes (written by l1-draft-increment.ps1 /
# l2-executor.ps1):
#   {ts, loop:L1, spec_N:<N|->, event:drafted|idle|failed[, detail:...]}
#   {ts, loop:L2, spec_N:<N>,         event:built|rejected[, detail:...]}
#   {ts, loop:L3, spec_N:-,           event:evolved-proposal}
#
# WAKE (print "WAKE", append an evolved-proposal marker, exit 0) ONLY when
# BOTH hold:
#   (a) PATTERN -- a repetition worth proposing on:
#         - >= K consecutive `event:rejected` for the SAME spec_N (a topic
#           the verifier keeps rejecting), OR
#         - >= K consecutive L1 `event:idle` (the loop is pacing / stalled,
#           no draft is getting built), OR
#         - >= K consecutive STALLED specs -- a spec_N that has a `rejected`
#           (or L1 `failed`) but no `built` since, appearing back-to-back.
#   (b) MIN-RUNS -- >= N L1 runs (drafted|idle|failed) since the last
#       `evolved-proposal` marker (or since log start if none).
#
# IDLE (print "IDLE", write NOTHING, exit 0) when pattern is absent OR
# min-runs is not met. This mirrors L1's idle contract: no proposal is a
# clean no-op, never a failure.
#
# On WAKE it appends `{ts, loop:L3, spec_N:-, event:evolved-proposal}` so the
# min-runs counter resets for the next cycle (pure log write, no LLM).
#
# Space-in-path safe: -LiteralPath / Join-Path throughout.
param(
    [Parameter(Mandatory=$true)]  [string] $Log,
    # Consecutive rejection / idle / stalled-spec threshold K. Default 3 (Issue 3).
    [int]    $K = 3,
    # Minimum L1 runs since last evolved-proposal. Default 5 (Issue 3).
    [int]    $N = 5
)

$ErrorActionPreference = 'Stop'
# The log may not exist yet (fresh repo) -> treat as empty, idle cleanly.
if (-not (Test-Path -LiteralPath $Log)) {
    Write-Host "IDLE"
    exit 0
}
$logPath = Resolve-Path -LiteralPath $Log

# ── SHARED RUN LOG (append the evolved-proposal marker on WAKE) ──────────────
# Resolve the log at the agent-loop repo root (one level above plans/), matching
# l1-draft-increment.ps1 / l2-executor.ps1.
$RunLog = Join-Path (Split-Path $PSScriptRoot) 'loop-run-log.md'
function Log-Run ([string]$N, [string]$Event, [string]$Detail = '') {
    $ts  = Get-Date -UFormat '+%Y-%m-%dT%H:%M:%S'
    $det = if ($Detail) { ", detail:$Detail" } else { '' }
    $line = "{ts:$ts, loop:L3, spec_N:$N, event:$Event$det}"
    Add-Content -LiteralPath $RunLog -Value $line -NoNewline
}

# One log line -> parsed fields, or $null if the line is malformed.
function Parse-Line ([string]$Raw) {
    $m = [regex]::Match($Raw, '^\{ts:([^,]+), loop:(L1|L2|L3), spec_N:(\d+|-), event:([\w-]+)(?:, detail:(.*))?\}$')
    if (-not $m.Success) { return $null }
    return @{
        ts      = $m.Groups[1].Value
        loop    = $m.Groups[2].Value
        spec_N  = $m.Groups[3].Value
        event   = $m.Groups[4].Value
        detail  = if ($m.Groups[5].Success) { $m.Groups[5].Value } else { '' }
    }
}

$lines = if (Test-Path -LiteralPath $logPath) {
    @(Get-Content -LiteralPath $logPath -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 })
} else { @() }

# ---- (b) MIN-RUNS: L1 runs since the last evolved-proposal marker ----
$l1SinceProposal = 0
$seenProposal = $false
# Walk newest -> oldest so the FIRST evolved-proposal we hit is the most recent.
for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $p = Parse-Line $lines[$i]
    if ($null -eq $p) { continue }
    if ($p.event -eq 'evolved-proposal') { $seenProposal = $true; break }
    if ($p.loop -eq 'L1') { $l1SinceProposal++ }
}
$minRunsMet = $l1SinceProposal -ge $N

# ---- (a) PATTERN: rejection / idle / stalled-spec streaks ----
# Track the MAX streak seen (not just the trailing one) so a qualifying
# run of K consecutive signals anywhere in the log still satisfies the
# pattern even if a later line resets the running counter.
$rejectStreak   = 0   # consecutive `rejected` for the SAME spec_N
$rejectSameN    = $null
$idleStreak     = 0   # consecutive L1 `idle`
$stalledStreak  = 0   # consecutive STALLED specs (rejected/failed, no built since)
$maxReject      = 0
$maxIdle        = 0
$maxStalled     = 0
$builtSoFar     = @{}  # spec_N -> bool built-seen (within streak window we only need "none yet")

foreach ($raw in $lines) {
    $p = Parse-Line $raw
    if ($null -eq $p) { continue }
    if ($p.event -eq 'evolved-proposal') { continue }  # marker, not a signal

    if (($p.event -eq 'rejected') -or ($p.event -eq 'failed')) {
        # (1) same-spec_N consecutive rejection streak (a topic the
        #     verifier keeps rejecting).
        if (($p.spec_N -ne '-') -and ($rejectSameN -eq $p.spec_N)) { $rejectStreak++ }
        elseif ($p.spec_N -ne '-') { $rejectSameN = $p.spec_N; $rejectStreak = 1 }
        else { $rejectSameN = $null; $rejectStreak = 0 }
        if ($rejectStreak -gt $maxReject) { $maxReject = $rejectStreak }
        # (2) stalled-spec fallback: a spec rejected/failed with NO built
        #     since. Consecutive such specs form the stalled streak.
        if (($p.spec_N -ne '-') -and (-not $builtSoFar.ContainsKey($p.spec_N))) {
            $stalledStreak++
        } else {
            $stalledStreak = 0
        }
        if ($stalledStreak -gt $maxStalled) { $maxStalled = $stalledStreak }
        $idleStreak = 0
        continue
    }

    if ($p.loop -eq 'L1' -and $p.event -eq 'idle') {
        $idleStreak++
        if ($idleStreak -gt $maxIdle) { $maxIdle = $idleStreak }
        $rejectStreak = 0; $rejectSameN = $null; $stalledStreak = 0
        continue
    }

    if ($p.event -eq 'built') {
        $builtSoFar[$p.spec_N] = $true
        $stalledStreak = 0
        $rejectStreak = 0; $rejectSameN = $null; $idleStreak = 0
        continue
    }

    # Any other line (drafted, etc.) breaks every running streak;
    # the MAX trackers preserve a qualifying run seen earlier.
    $rejectStreak = 0; $rejectSameN = $null
    $idleStreak = 0; $stalledStreak = 0
}

# $maxReject / $maxIdle / $maxStalled were tracked inside the loop.
$patternMet = ($maxReject -ge $K) -or ($maxIdle -ge $K) -or ($maxStalled -ge $K)

# ---- DECISION ----
if ($patternMet -and $minRunsMet) {
    Log-Run '-' 'evolved-proposal' "wake: pattern(K=$K,N=$N) minRuns=$l1SinceProposal"
    Write-Host "WAKE"
    exit 0
}

Write-Host "IDLE"
exit 0
