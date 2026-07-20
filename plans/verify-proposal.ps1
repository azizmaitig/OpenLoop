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

$ErrorActionPreference = 'Stop'
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
$requiredFields = @('date', 'trigger_pattern', 'target_file', 'current', 'why', 'confidence')
$missing = $requiredFields | Where-Object { -not ($propContent -match [regex]::Escape($_)) }
if ($missing.Count -gt 0) {
    Write-Error "VERIFY-PROPOSAL: FAIL - proposal missing required field(s): $($missing -join ', ')."
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
$locked = @('agent-loop/src/', 'spec-factory/')
$bad = $locked | Where-Object { $patchContent -match [regex]::Escape($_) }
if ($bad.Count -gt 0) {
    Write-Error "VERIFY-PROPOSAL: FAIL - patch touches locked path(s): $($bad -join ', '). Scope B forbids editing engine/src or spec-factory content."
    exit 1
}

Write-Host 'VERIFY-PROPOSAL: PASS - proposal + patch present, fields complete, scope B respected.'
exit 0
