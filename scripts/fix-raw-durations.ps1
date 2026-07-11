param([string]$TargetDir = "..\calendar-app")

$cssPath = Join-Path (Resolve-Path $TargetDir) "src\App.css"
if (-not (Test-Path $cssPath)) {
    Write-Host "ERROR: CSS file not found at $cssPath"
    exit 1
}

$css = Get-Content $cssPath -Raw
$changes = 0

# 0.25s -> var(--duration-toast)
$r1 = [regex]::Matches($css, '(?<!var\(--duration-)\b0\.25s\b')
if ($r1.Count -gt 0) {
    $css = $css -replace '(?<!var\(--duration-)\b0\.25s\b', 'var(--duration-toast)'
    Write-Host ("Replaced 0.25s -> var(--duration-toast): " + $r1.Count)
    $changes += $r1.Count
}

# 0.3s -> var(--duration-slow)
$r2 = [regex]::Matches($css, '(?<!var\(--duration-)\b0\.3s\b')
if ($r2.Count -gt 0) {
    $css = $css -replace '(?<!var\(--duration-)\b0\.3s\b', 'var(--duration-slow)'
    Write-Host ("Replaced 0.3s -> var(--duration-slow): " + $r2.Count)
    $changes += $r2.Count
}

# 0.2s -> var(--duration-slow)
$r3 = [regex]::Matches($css, '(?<!var\(--duration-)\b0\.2s\b')
if ($r3.Count -gt 0) {
    $css = $css -replace '(?<!var\(--duration-)\b0\.2s\b', 'var(--duration-slow)'
    Write-Host ("Replaced 0.2s -> var(--duration-slow): " + $r3.Count)
    $changes += $r3.Count
}

Set-Content $cssPath -Value $css -NoNewline
Write-Host ("Total replacements: " + $changes)
exit 0
