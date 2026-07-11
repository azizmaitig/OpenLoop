param([string]$TargetDir = "..\calendar-app")
$cssPath = Join-Path (Resolve-Path $TargetDir) "src\App.css"
$appTsxPath = Join-Path (Resolve-Path $TargetDir) "src\App.tsx"
$content = Get-Content $cssPath -Raw

Write-Host "=== FILE STATS ==="
Write-Host ("App.css: " + (Get-Item $cssPath).Length + " bytes, " + (Get-Content $cssPath).Count + " lines")

Write-Host "`n=== HEX COLORS ==="
$hexMatches = [regex]::Matches($content, '#[\da-fA-F]{3,8}')
Write-Host ("Hardcoded hex colors: " + $hexMatches.Count)

Write-Host "`n=== OKLCH COLORS ==="
$oklchMatches = [regex]::Matches($content, 'oklch\([^)]+\)')
Write-Host ("oklch() usages: " + $oklchMatches.Count)

Write-Host "`n=== CSS VARIABLE USAGE ==="
$varMatches = [regex]::Matches($content, 'var\(--[^)]+\)')
Write-Host ("var() references: " + $varMatches.Count)

Write-Host "`n=== DARK OVERRIDES ==="
$darkSelectors = [regex]::Matches($content, '\[data-theme=')
Write-Host ("[data-theme] selectors: " + $darkSelectors.Count)

Write-Host "`n=== TRANSITION DURATIONS ==="
$rawDurations = [regex]::Matches($content, '(?<!var\(--duration-)\b0\.\d+s\b')
Write-Host ("Raw duration values (not var()): " + $rawDurations.Count)
$byDuration = $rawDurations | Group-Object Value
$byDuration | ForEach-Object { Write-Host ("  " + $_.Name + ": " + $_.Count) }

Write-Host "`n=== TOP 20 MOST USED var() REFS ==="
$varMatches | Group-Object Value | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object {
    Write-Host ("  " + $_.Name + ": " + $_.Count)
}

Write-Host "`n=== App.tsx CALLBACK ISSUES ==="
$tsx = Get-Content $appTsxPath -Raw
$useCallback = [regex]::Matches($tsx, 'useCallback\(').Count
$useMemo = [regex]::Matches($tsx, 'useMemo\(').Count
$reactMemo = [regex]::Matches($tsx, 'React\.memo\|memo\(').Count
Write-Host ("useCallback usages: " + $useCallback)
Write-Host ("useMemo usages: " + $useMemo)
Write-Host ("React.memo usages: " + $reactMemo)
