# l3-check-trigger.ps1 -- L3 evolve-pass trigger step (Issue 4 plan task).
#
# Wrapper around l3-should-evolve.ps1 that drops/clears the should-evolve flag
# based on the WAKE/IDLE decision. Runs as a REAL script file (not an inline
# -Command string) so $PSScriptRoot resolves to plans/ and Join-Path works
# (inline -Command leaves $PSScriptRoot empty -> Join-Path throws).
#
# IDLE  -> no flag, exit 0 (evolve idles this cycle, no false failure).
# WAKE  -> writes .build/spec-evolve/should-evolve.flag, exit 0.
# Space-in-path safe: -LiteralPath / Join-Path throughout.

$ErrorActionPreference = 'Continue'
$root     = Split-Path $PSScriptRoot                    # agent-loop repo root
$log      = Join-Path $root 'loop-run-log.md'
$out      = Join-Path (Join-Path $root '.build') 'spec-evolve'
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out -Force | Out-Null }
$flag     = Join-Path $out 'should-evolve.flag'

$decision = & {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'l3-should-evolve.ps1') -Log $log
}

if ($decision -match 'WAKE') {
    Set-Content -LiteralPath $flag -Value (Get-Date -UFormat '+%Y-%m-%dT%H:%M:%S')
    Write-Host 'L3 TRIGGER: WAKE - flag set, evolve will fire.'
} else {
    if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag -Force }
    Write-Host 'L3 TRIGGER: IDLE - no flag, evolve will idle.'
}
exit 0
