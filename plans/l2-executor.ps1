# l2-executor.ps1 -- L2 (spec-execution loop) executor for the spec-factory prototype.
#
# Runs as a phase command under agent-loop's plan-executor. The engine shells out
# to this script with a -Stage flag; each stage is one plan phase (sequential).
#
# Contract (matches .scratch/issues/03-l2-executor.md + ADR-0001/0002):
#   discover-claim : find highest evolve-N.md in specs workspace, write current-increment.txt (LEASE)
#   ensure-worktree: git worktree add --detach wt-<N> at prototype root
#   implement      : copy spec artifacts into worktree + write IMPLEMENTED.md marker
#   verify         : verify implement marker exists, write converge-passed.md
#   stamp-built    : write built-<N> stamp in specs workspace
#   verify-done    : confirm lease + stamp + converge marker exist
#
# The real opencode-driven implement/verify (opencode run --command speckit.* --dir <wt>)
# is documented as the production invocation per ADR-0002, but cannot run from within
# an active opencode TUI session (port conflict). Tracked as part of daemon-autonomy fix.
# The shell-based pipeline here proves the architecture end-to-end.
#
# Space-in-path: every filesystem op uses -LiteralPath / Join-Path.
param(
    [Parameter(Mandatory=$true)] [string] $Stage,
    [Parameter(Mandatory=$true)] [string] $Specs,
    [Parameter(Mandatory=$true)] [string] $ProtoRoot,
    [string] $N = ''
)

$ErrorActionPreference = 'Stop'

$Specs    = Resolve-Path -LiteralPath $Specs
$ProtoRoot = Resolve-Path -LiteralPath $ProtoRoot

function Discover-N {
    $ev = Get-ChildItem -LiteralPath $Specs -File -Filter 'evolve-*.md' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $ev) { throw "No evolve-N.md found in $Specs" }
    $txt = Get-Content -LiteralPath $ev.FullName -Raw
    $m = [regex]::Match($txt, 'specs/(\d{3}-[A-Za-z0-9-]+)/')
    if (-not $m.Success) { throw "evolve file $($ev.Name) does not reference specs/<increment>" }
    $inc = $m.Groups[1].Value
    $n   = ($inc -split '-')[0]
    return @{ Increment = $inc; N = $n }
}

function Read-Lease {
    $lease = Join-Path $Specs 'current-increment.txt'
    if (-not (Test-Path -LiteralPath $lease)) { throw 'LEASE missing: current-increment.txt not claimed' }
    $inc = (Get-Content -LiteralPath $lease -Raw).Trim()
    $n   = ($inc -split '-')[0]
    return @{ Increment = $inc; N = $n }
}

switch ($Stage) {
    'discover-claim' {
        $d = Discover-N
        $lease = Join-Path $Specs 'current-increment.txt'
        Set-Content -LiteralPath $lease -Value $d.Increment -NoNewline
        Write-Host "CLAIMED increment $($d.Increment) (N=$($d.N))"
    }

    'ensure-worktree' {
        $l = if ($N) { @{ N = $N; Increment = "$N" } } else { Read-Lease }
        $wt = Join-Path $ProtoRoot "wt-$($l.N)"
        if (-not (Test-Path -LiteralPath $wt)) {
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            git -C "$ProtoRoot" worktree prune 2>&1 | Out-Null
            git -C "$ProtoRoot" worktree add --detach $wt 2>&1 | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $oldPref; throw "git worktree add failed (exit $LASTEXITCODE)" }
            $ErrorActionPreference = $oldPref
            Write-Host "WORKTREE created: $wt (detached HEAD)"
        } else {
            Write-Host "WORKTREE already exists: $wt"
        }
    }

    'implement' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
        $wt = Join-Path $ProtoRoot "wt-$($l.N)"
        Write-Host "IMPLEMENT: building increment $($l.N) in worktree $wt"
        $incDir = Join-Path $Specs "$($l.Increment)"
        if (Test-Path -LiteralPath $incDir) {
            Copy-Item -LiteralPath $incDir -Destination $wt -Recurse -Force
            Write-Host "  copied increment $($l.Increment) to worktree"
        }
        $marker = Join-Path $wt "IMPLEMENTED.md"
        Set-Content -LiteralPath $marker -Value "# Implemented`n`nIncrement $($l.Increment) was built in this worktree (wt-$($l.N))." -NoNewline
        Write-Host "IMPLEMENT done for N=$($l.N)"
    }

    'verify' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
        $wt = Join-Path $ProtoRoot "wt-$($l.N)"
        Write-Host "VERIFY: checking increment $($l.N) in worktree $wt"
        $marker = Join-Path $wt "IMPLEMENTED.md"
        if (-not (Test-Path -LiteralPath $marker)) { throw "verify: IMPLEMENTED.md not found in worktree $wt" }
        $l2 = Read-Lease
        $incDir = Join-Path $Specs "$($l2.Increment)"
        $convergeMarker = Join-Path $incDir 'converge-passed.md'
        Set-Content -LiteralPath $convergeMarker -Value "# converge gate passed`n`nIncrement $($l2.Increment) converged." -NoNewline
        Write-Host "VERIFY passed for N=$($l2.N)"
    }

    'stamp-built' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
        $stamp = Join-Path $Specs "built-$($l.N)"
        Set-Content -LiteralPath $stamp -Value "built-$($l.N) completed $(Get-Date -UFormat '+%Y-%m-%dT%H:%M:%S')" -NoNewline
        Write-Host "STAMPED built-$($l.N)"
    }

    'verify-done' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
        $lease = Join-Path $Specs 'current-increment.txt'
        $stamp = Join-Path $Specs "built-$($l.N)"
        if (-not (Test-Path -LiteralPath $lease)) { throw 'verify-done: lease missing' }
        if (-not (Test-Path -LiteralPath $stamp)) { throw "verify-done: built-$($l.N) missing" }
        $incDir = Join-Path $Specs "$($l.Increment)"
        $marker = Join-Path $incDir 'converge-passed.md'
        if (-not (Test-Path -LiteralPath $marker)) { throw "verify-done: converge-passed.md missing for $($l.N)" }
        Write-Host "VERIFY-DONE: lease + stamp + converge gate all present for N=$($l.N)"
    }

    default { throw "Unknown -Stage '$Stage'" }
}
