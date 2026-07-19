# l1-draft-increment.ps1 - ADR-0018 L1 spec creation (speckit.* chain).
#
# Reads the one idea from -IdeaFile (produced by l1-read-inbox.ps1). If the file is
# absent, L1 idles this cycle: exits 0 and writes NO evolve-N (pacing OK, no false
# failure). If present, runs the speckit.* chain (Mode-2 minimal, ADR-0002) inside the
# spec-factory workspace via `opencode run`, seeded from the one-line idea instead of
# an interactive /speckit.clarify. Each step is a SEPARATE `opencode run` call - the
# identical manual flow a human types (no "; then" chaining ambiguity).
#     /speckit.specify <idea>
#     /speckit.plan
#     /speckit.tasks
# Constitution is respected automatically (.specify/memory/constitution.md).
#
# L1 authors SPEC TEXT ONLY (never product source) - locked boundary.
#
# CWD resolution: we Push-Location into -Workspace so the engine (which launches the
# script from the agent-loop root) still resolves .opencode/commands/speckit.* and
# .specify/. We do NOT pass --dir: PLAN-WRITING-GUIDE P2 documents that
# `opencode run --dir "<space path>"` fails with "Failed to change directory".
#
# Artifact guard: after the chain, if NO evolve-N*.md appeared in the specs workspace
# we exit 1 (the chain exited 0 but produced nothing - a silent no-op). verify-draft
# in the plan is the secondary gate.
#
# Space-in-path safe: -LiteralPath / Join-Path throughout.
#
# Exit codes:
#   0  = drafted (evolve-N produced) OR idle (no idea)
#   1  = missing CLI, chain failure, or chain exited 0 but wrote no evolve-N
param(
    [Parameter(Mandatory=$true)]  [string] $Specs,
    [Parameter(Mandatory=$true)]  [string] $IdeaFile,
    [Parameter(Mandatory=$true)]  [string] $Workspace,
    # opencode CLI. Resolved from PATH first; falls back to the known npm-global
    # install so the engine's non-interactive `powershell -NoProfile -File` context
    # (no PATH to the .ps1 shim) can still launch it. Override for other installs.
    [string] $Opencode
)

$ErrorActionPreference = 'Stop'
$specs     = Resolve-Path -LiteralPath $Specs
$ideaFile  = $IdeaFile
$workspace = Resolve-Path -LiteralPath $Workspace

# Resolve the opencode binary (PATH, else the documented npm-global location).
if (-not $Opencode) {
    $onPath = Get-Command -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'opencode.exe' } | Select-Object -First 1
    if ($onPath) {
        $Opencode = $onPath.Source
    } else {
        $Opencode = "C:\Users\azizm\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe"
    }
}
if (-not (Test-Path -LiteralPath $Opencode)) {
    Write-Error "L1 DRAFT: opencode CLI not found at '$Opencode'. Install opencode or pass -Opencode <path>."
    exit 1
}

# Idle branch: no idea consumed this cycle.
if (-not (Test-Path -LiteralPath $ideaFile)) {
    Write-Host "L1 DRAFT: no .next-idea.txt - inbox empty or gate blocked. Idling (no evolve-N written)."
    exit 0
}

$idea = (Get-Content -LiteralPath $ideaFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($idea)) {
    Write-Host "L1 DRAFT: .next-idea.txt empty - idling (no evolve-N written)."
    exit 0
}

Write-Host "L1 DRAFT: running speckit chain for idea -> '$idea'"

# Run from the spec-factory workspace so .opencode/commands/speckit.* + .specify/
# resolve. Each step is its own `opencode run` (the exact manual flow).
Push-Location -LiteralPath $workspace
try {
    & $Opencode run "/speckit.specify $idea"
    if ($LASTEXITCODE -ne 0) { Write-Error "L1 DRAFT: /speckit.specify failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }

    & $Opencode run "/speckit.plan"
    if ($LASTEXITCODE -ne 0) { Write-Error "L1 DRAFT: /speckit.plan failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }

    & $Opencode run "/speckit.tasks"
    if ($LASTEXITCODE -ne 0) { Write-Error "L1 DRAFT: /speckit.tasks failed (exit $LASTEXITCODE)."; exit $LASTEXITCODE }
} finally {
    Pop-Location
}

# Artifact guard: the chain must have produced an evolve-N*.md checkpoint in the specs workspace.
$produced = @(Get-ChildItem -LiteralPath $specs -File -Filter 'evolve-*.md' -ErrorAction SilentlyContinue)
if ($produced.Count -eq 0) {
    Write-Error "L1 DRAFT: speckit chain exited 0 but produced no evolve-N*.md checkpoint in $specs."
    exit 1
}

Write-Host "L1 DRAFT: speckit chain complete - $($produced.Count) evolve-N checkpoint(s) in specs workspace."
exit 0
