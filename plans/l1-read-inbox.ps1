# l1-read-inbox.ps1 - ADR-0018 idea intake (filesystem inbox).
#
# Reads the TOP non-empty line from <Specs>/ideas/inbox.md. If a line exists, it is
# peeled off the inbox (removed so it is not re-drafted) and written verbatim to -Out.
# If the inbox is missing or empty, writes nothing to -Out and exits 0 (L1 idles this
# cycle - no false failure). Space-in-path safe: every op uses -LiteralPath / Join-Path.
#
# Pacing (Issue 6): exactly ONE idea per cron cycle. We take only the top line.
param(
    [Parameter(Mandatory=$true)] [string] $Specs,
    [Parameter(Mandatory=$true)] [string] $Out
)

$ErrorActionPreference = 'Stop'
$specs    = Resolve-Path -LiteralPath $Specs
$inbox    = Join-Path (Join-Path $specs 'ideas') 'inbox.md'
$outFile  = $Out

# No inbox yet -> nothing to draft. Exit 0, leave no .next-idea.txt.
if (-not (Test-Path -LiteralPath $inbox)) {
    Write-Host "L1 INBOX: no inbox.md present - nothing to draft this cycle."
    exit 0
}

$lines = @(Get-Content -LiteralPath $inbox -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 })
if ($lines.Count -eq 0) {
    Write-Host "L1 INBOX: inbox.md empty - nothing to draft this cycle."
    exit 0
}

# Peel the top idea line.
$idea = $lines[0].Trim()
$rest = $lines[1..($lines.Count - 1)]

# Rewrite the inbox without the consumed line (keep remaining ideas for future cycles).
$ideasDir = Split-Path -Parent $inbox
if (-not (Test-Path -LiteralPath $ideasDir)) { New-Item -ItemType Directory -Path $ideasDir -Force | Out-Null }
Set-Content -LiteralPath $inbox -Value $rest -Encoding UTF8

# Hand the single idea to the next task.
Set-Content -LiteralPath $outFile -Value $idea -Encoding UTF8
Write-Host "L1 INBOX: consumed idea -> '$idea' ($(@($rest).Count) idea(s) remaining in inbox)."
exit 0
