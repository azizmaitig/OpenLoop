# l1-verify-draft.ps1 -- L1 draft handoff invariant check (spec-creator.yaml verify-draft).
#
# Verify L1's handoff WITHOUT penalizing idle cycles (ADR-0018). draft-increment
# idles (writes nothing) when the inbox is empty or the gate blocked, so "no
# evolve-N at all" is a VALID idle result -> exit 0. The only hard failure is the
# Issue 6 pacing invariant: if any evolve-* exist, at most ONE may be unconsumed
# (no matching built-N). Pacing violation -> exit 1.
#
# Runs as a REAL script file (not inline -Command) so $vars resolve and the
# executor's temp .cmd wrapper cannot mangle $-expressions (see PLAN-WRITING-GUIDE §11).
# Space-in-path safe: -LiteralPath / Join-Path throughout.

param(
    [Parameter(Mandatory=$true)] [string] $Specs
)

$ErrorActionPreference = 'Continue'
$ev = @(Get-ChildItem -LiteralPath $Specs -File -Filter 'evolve-*.md' -ErrorAction SilentlyContinue)
if ($ev.Count -eq 0) {
    Write-Host 'verify-draft: idle cycle (no evolve-N) - pacing OK, nothing to verify'
    exit 0
}
$unconsumed = 0
foreach ($f in $ev) {
    $m = [regex]::Match($f.Name, '^evolve-(\d{3})')
    if ($m.Success -and -not (Test-Path -LiteralPath (Join-Path $Specs ('built-' + $m.Groups[1].Value)))) {
        $unconsumed++
    }
}
if ($unconsumed -ge 2) {
    Write-Error ("verify-draft: pacing violation - " + $unconsumed + " unconsumed evolve-* coexist")
    exit 1
}
Write-Host 'verify-draft: evolve-N.md checkpoint present (L1 handoff ready, pacing OK)'
exit 0
