# verify-build.ps1 — runs npm build on the calendar-app project.
#
# Project path is hardcoded (not a parameter) to avoid Windows cmd.exe
# stripping quotes from paths with spaces when routed through the loop's
# cmd.exe /c execution layer.

$ErrorActionPreference = "Stop"

$ProjectDir = "D:\projects\obsidian\second brain\10-Projects\11-Active\calendar-app"

# Resolve npm.cmd path
$npmCandidates = @(
    "C:\Program Files\nodejs\npm.cmd",
    "$env:APPDATA\npm\npm.cmd",
    "$env:LOCALAPPDATA\npm\npm.cmd"
)

$npmPath = $null
foreach ($candidate in $npmCandidates) {
    if (Test-Path $candidate) {
        $npmPath = $candidate
        break
    }
}

if (-not $npmPath) {
    $npmPath = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
}

if (-not $npmPath) {
    Write-Error "npm.cmd not found in any known location or PATH"
    exit 1
}

Write-Host "[verify-build] Running: $npmPath --prefix `"$ProjectDir`" run build"

& $npmPath --prefix $ProjectDir run build
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Error "[verify-build] Build failed with exit code $exitCode"
}
exit $exitCode
