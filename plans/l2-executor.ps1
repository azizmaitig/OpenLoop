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

# Parse the increment identifier N from a lease/increment token.
#
# Two shapes are accepted (Issue 6 upgrade + backward-compatible legacy):
#   RICH : "003|D:\...spec-factory\specs\wt-003|role=L2-executor|ttl=3600"
#          -> N is the FIRST '|'-delimited field.
#   LEGACY: "003-watchdir-trigger"
#          -> N is the leading numeric segment before the first '-'.
# The '|' form is authoritative for Issue 6; the legacy branch only exists so
# a pre-Issue-6 lease is not mis-parsed (e.g. "003|wt" must NOT collapse to a
# '-' split that yields garbage).
function Parse-N ([string] $Token) {
    $t = $Token.Trim()
    if ($t -match '\|') {
        return ($t -split '\|')[0]
    }
    return ($t -split '-')[0]
}

function Discover-N {
    $ev = Get-ChildItem -LiteralPath $Specs -File -Filter 'evolve-*.md' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $ev) { throw "No evolve-N.md found in $Specs" }
    $txt = Get-Content -LiteralPath $ev.FullName -Raw
    $m = [regex]::Match($txt, 'specs/(\d{3}-[A-Za-z0-9-]+)/')
    if (-not $m.Success) { throw "evolve file $($ev.Name) does not reference specs/<increment>" }
    $inc = $m.Groups[1].Value
    $n   = Parse-N $inc
    return @{ Increment = $inc; N = $n }
}

function Read-Lease {
    $lease = Join-Path $Specs 'current-increment.txt'
    if (-not (Test-Path -LiteralPath $lease)) { throw 'LEASE missing: current-increment.txt not claimed' }
    $raw = (Get-Content -LiteralPath $lease -Raw).Trim()
    $n   = Parse-N $raw
    return @{ Raw = $raw; N = $n }
}

# Resolve the increment directory name for a given N from the evolve-N.md body.
# Does NOT depend on Read-Lease or Discover-N — pure lookup by N.
# Returns e.g. "003-watchdir-trigger".
function Resolve-IncrementDir ([string]$N) {
    $ev = Get-ChildItem -LiteralPath $Specs -File -Filter "evolve-$N*.md" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $ev) { throw "No evolve-$N.md found to resolve increment directory" }
    $txt = Get-Content -LiteralPath $ev.FullName -Raw
    $m = [regex]::Match($txt, 'specs/(\d{3}-[A-Za-z0-9-]+)/')
    if (-not $m.Success) { throw "evolve-$N.md does not reference specs/<increment>" }
    return $m.Groups[1].Value
}

switch ($Stage) {
    'discover-claim' {
        $d = Discover-N
        $lease = Join-Path $Specs 'current-increment.txt'

        # ── COLLISION GATE (Issue 4) ──────────────────────────────────────────
        # If a lease already exists AND it names the SAME increment N that this
        # scan wants to claim, two L2 scans are racing the same number. The
        # second scan must ESCALATE (human gate): write collision-<N>.alert,
        # exit non-zero, and must NOT overwrite the existing lease.
        # If the existing lease is for a LOWER increment, this is a new
        # increment (normal operation) — overwrite is allowed. N is parsed via
        # Parse-N so the rich "N|<path>|role=|ttl=" lease shape is compared by
        # the numeric increment, not the raw whole token.
        if (Test-Path -LiteralPath $lease) {
            $existing = (Get-Content -LiteralPath $lease -Raw).Trim()
            $existingN = Parse-N $existing
            # Same N: two scans racing the same increment -> escalate (human gate).
            # Higher N: a newer increment is already claimed; downgrading the lease
            # backward would let L1 draft a stale N. Treat as collision too.
            if (($existingN -eq $d.N) -or ($existingN -gt $d.N)) {
                $alert = Join-Path $Specs "collision-$($d.N).alert"
                $ts = Get-Date -UFormat '+%Y-%m-%dT%H:%M:%S'
                $msg = "COLLISION at N=$($d.N) - existing lease '$existing' already claims N>=$($d.N). Second claim escalated (human gate). Existing lease NOT overwritten at $ts."
                Set-Content -LiteralPath $alert -Value $msg -NoNewline
                Write-Host "COLLISION: lease for N=$($d.N) already claimed by another L2 scan (existing '$existing'). Escalating (human gate)."
                exit 1
            }
            # existingN < d.N: normal new-increment claim, fall through to overwrite.
        }

        # RICH LEASE FORMAT (Issue 6): N|<worktree-path>|role=L2-executor|ttl=3600
        # Only ONE L2 daemon exists, so a plain claim is sufficient (TTL optional).
        $wtPath = Join-Path $ProtoRoot "wt-$($d.N)"
        $leaseVal = "$($d.N)|$wtPath|role=L2-executor|ttl=3600"
        Set-Content -LiteralPath $lease -Value $leaseVal -NoNewline
        Write-Host "CLAIMED increment $($d.Increment) (N=$($d.N)) -> lease: $leaseVal"
    }

    'ensure-worktree' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
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
        $incName = Resolve-IncrementDir $l.N
        $incDir = Join-Path $Specs $incName
        if (Test-Path -LiteralPath $incDir) {
            Copy-Item -LiteralPath $incDir -Destination $wt -Recurse -Force
            Write-Host "  copied increment $incName to worktree"
        }
        $marker = Join-Path $wt "IMPLEMENTED.md"
        Set-Content -LiteralPath $marker -Value "# Implemented`n`nIncrement $incName was built in this worktree (wt-$($l.N))." -NoNewline
        Write-Host "IMPLEMENT done for N=$($l.N)"
    }

    'verify' {
        $l = if ($N) { @{ N = $N } } else { Read-Lease }
        $wt = Join-Path $ProtoRoot "wt-$($l.N)"
        Write-Host "VERIFY: checking increment $($l.N) in worktree $wt"
        $marker = Join-Path $wt "IMPLEMENTED.md"
        if (-not (Test-Path -LiteralPath $marker)) { throw "verify: IMPLEMENTED.md not found in worktree $wt" }
        $l2 = Read-Lease
        $incName = Resolve-IncrementDir $l2.N
        $incDir = Join-Path $Specs $incName
        $convergeMarker = Join-Path $incDir 'converge-passed.md'
        Set-Content -LiteralPath $convergeMarker -Value "# converge gate passed`n`nIncrement $incName converged." -NoNewline
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
        $incName = Resolve-IncrementDir $l.N
        $incDir = Join-Path $Specs $incName
        $marker = Join-Path $incDir 'converge-passed.md'
        if (-not (Test-Path -LiteralPath $marker)) { throw "verify-done: converge-passed.md missing for $($l.N)" }
        Write-Host "VERIFY-DONE: lease + stamp + converge gate all present for N=$($l.N)"
    }

    default { throw "Unknown -Stage '$Stage'" }
}
