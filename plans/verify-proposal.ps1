# verify-proposal.ps1 - L3 evolve-pass proposal gate (Issue 4, PRD user story #5).
#
# Deterministic (no LLM) verification that runs as the plan's final verify task.
# Contract:
#   - If check-trigger WOKE (the ./plans/l3-should-evolve.ps1 wrote a flag at
#     .build/spec-evolve/should-evolve.flag), then a real proposal MUST exist:
#       * .build/spec-evolve/spec-evolve-proposals.md  (non-empty, has the 6 fields)
#       * .build/spec-evolve/spec-evolve.patch          (non-empty)
#     Failure to satisfy -> exit 1 (fail loud; catches silent LLM no-ops).
#   - If the trigger IDLED (no flag), this is a clean no-op -> exit 0.
#
# Scope B guard: the patch must NOT touch agent-loop/src/ or spec-factory/
# content. A patch that does is rejected loudly (ADR-0019 section 1: engine and
# reference deliverables are locked).
#
# Space-in-path safe: -LiteralPath / Join-Path throughout.
param(
    # Override the agent-loop root (defaults to one level above this script's plans/ dir).
    [string] $Root
)

# Continue (not Stop): this script reports failures via Write-Error + exit, and a
# rejected `git apply --check` emits stderr that would otherwise abort under Stop.
$ErrorActionPreference = 'Continue'
$root = if ($Root) { $Root } else { Split-Path $PSScriptRoot }
$buildDir = Join-Path (Join-Path $root '.build') 'spec-evolve'
$flag     = Join-Path $buildDir 'should-evolve.flag'
$proposal = Join-Path $buildDir 'spec-evolve-proposals.md'
$patch    = Join-Path $buildDir 'spec-evolve.patch'

# Idle branch: trigger never woke -> clean no-op, exit 0.
if (-not (Test-Path -LiteralPath $flag)) {
    Write-Host 'VERIFY-PROPOSAL: no evolve flag - L3 idled this cycle. OK (exit 0).'
    exit 0
}

# Woke branch: a pattern was found, the LLM MUST have produced a proposal.
Write-Host 'VERIFY-PROPOSAL: evolve flag present - asserting proposal + patch exist and are well-formed.'

if (-not (Test-Path -LiteralPath $proposal)) {
    Write-Error 'VERIFY-PROPOSAL: FAIL - trigger woke but no proposal file.'
    exit 1
}
$propContent = (Get-Content -LiteralPath $proposal -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($propContent)) {
    Write-Error 'VERIFY-PROPOSAL: FAIL - proposal file is empty.'
    exit 1
}

# Required fields per proposal entry (ADR-0019 section 5 / Issue 5 schema).
# `current -> proposed` is emitted as ONE field by the evolve step (spec-evolve.yaml
# prompt: "- current -> proposed: ..."). Assert the PAIR, not just the bare token
# `current`, so a proposal that mentions "current" elsewhere but omits the
# current->proposed delta does not false-pass.
$requiredFields = @('date', 'trigger_pattern', 'target_file', 'why', 'confidence')
$missing = $requiredFields | Where-Object { -not ($propContent -match [regex]::Escape($_)) }
if ($missing.Count -gt 0) {
    Write-Error "VERIFY-PROPOSAL: FAIL - proposal missing required field(s): $($missing -join ', ')."
    exit 1
}
if (-not ($propContent -match 'current\s*-+>\s*proposed')) {
    Write-Error "VERIFY-PROPOSAL: FAIL - proposal missing the 'current -> proposed' delta field."
    exit 1
}

if (-not (Test-Path -LiteralPath $patch)) {
    Write-Error 'VERIFY-PROPOSAL: FAIL - trigger woke but no patch file.'
    exit 1
}
$patchContent = (Get-Content -LiteralPath $patch -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($patchContent)) {
    Write-Error 'VERIFY-PROPOSAL: FAIL - patch file is empty.'
    exit 1
}

# Scope B guard: patch must never target locked paths.
$locked = @('agent-loop/src/', 'spec-factory/', '12-active loop/')
$bad = $locked | Where-Object { $patchContent -match [regex]::Escape($_) }
if ($bad.Count -gt 0) {
    Write-Error "VERIFY-PROPOSAL: FAIL - patch touches locked path(s): $($bad -join ', '). Scope B forbids editing engine/src or spec-factory content."
    exit 1
}

# Applyability gate (Issue 5): the patch must be a real `git diff`-shaped file the
# human can `git apply`. `git apply --check` validates WITHOUT modifying the tree,
# run from the agent-loop root (which is the repo root for this project). A malformed
# or context-drifted patch fails loud here, before a human ever touches it.
# No `gh` dependency — this is a strictly local check (ADR-0019 human gate A).
# NOTE: this script uses Continue preference, so a rejected patch's stderr is a
# non-terminating message and $LASTEXITCODE is reliable.
$gitExe = (Get-Command git -ErrorAction SilentlyContinue)
$inWorkTree = $false
if ($null -ne $gitExe) {
    & git -C $root rev-parse --is-inside-work-tree 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $inWorkTree = $true }
}
if (-not $inWorkTree) {
    Write-Host 'VERIFY-PROPOSAL: SKIP - not a git work tree; cannot run apply --check (patch still validated for scope B).'
} else {
    $gitOut = & git -C $root apply --check $patch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "VERIFY-PROPOSAL: FAIL - patch does not apply cleanly (git apply --check from $root):`n$gitOut"
        exit 1
    }
    Write-Host 'VERIFY-PROPOSAL: OK - patch applies cleanly (git apply --check passed).'
}

Write-Host 'VERIFY-PROPOSAL: PASS - proposal + patch present, fields complete, scope B respected.'
exit 0
