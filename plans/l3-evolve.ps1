# l3-evolve.ps1 -- L3 evolve-pass propose step (Issue 4 plan task).
#
# Runs as a REAL script file (not an inline -Command string) so $PSScriptRoot
# resolves. If check-trigger did NOT wake (no flag), exit 0 WITHOUT spawning the
# LLM (idle branch). If the flag is present, run `opencode run` from the loop
# root (no --dir, no -m) and instruct the agent to WRITE the proposal + patch to
# absolute paths under .build/spec-evolve/. NEVER edit target files directly
# (Scope B). Space-in-path safe.

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot                    # agent-loop repo root
$flag = Join-Path (Join-Path (Join-Path $root '.build') 'spec-evolve') 'should-evolve.flag'
$out  = Join-Path (Join-Path $root '.build') 'spec-evolve'
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out -Force | Out-Null }

if (-not (Test-Path -LiteralPath $flag)) {
    Write-Host 'L3 EVOLVE: idle (no trigger) - skipping LLM propose.'
    exit 0
}

$proposalPath = Join-Path $out 'spec-evolve-proposals.md'
$patchPath    = Join-Path $out 'spec-evolve.patch'
$logPath      = Join-Path $root 'loop-run-log.md'

$instruction = @"
Read $logPath and every rejected evolve-N spec referenced by a `rejected`/`failed`/`idle` entry.
PROPOSE edits ONLY to the fast loops' intake/config layer: the specify seed prompt, the gate-evolve threshold, spec-creator.yaml task ordering/timeouts, or the l1-*.ps1 helpers. NEVER edit agent-loop/src/ or spec-factory/ command content.
Write a proposal file to $proposalPath with one block per proposal, each containing EXACTLY these fields:
  - date
  - trigger_pattern
  - target_file
  - current -> proposed
  - why
  - confidence
ALSO write a git-diff-shaped patch to $patchPath that the human can `git apply`. The patch MUST target only the intake/config files above - never src/ or spec-factory/.
Print ONLY 'proposal written'. Exit 0.
"@

Write-Host 'L3 EVOLVE: trigger fired - spawning opencode run propose step.'
opencode run --auto $instruction
if ($LASTEXITCODE -ne 0) {
    Write-Error "L3 EVOLVE: opencode run exited non-zero ($LASTEXITCODE)."
    exit 1
}
Write-Host 'L3 EVOLVE: done.'
exit 0
