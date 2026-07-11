param([string]$TargetDir = "..\calendar-app")

$calDir = Resolve-Path $TargetDir
Write-Host ("Building in: " + $calDir)
Set-Location $calDir

npm run build 2>&1 | ForEach-Object { $_ }
if ($LASTEXITCODE -eq 0) {
    Write-Host "BUILD PASSED"
    exit 0
} else {
    Write-Host ("BUILD FAILED with code: " + $LASTEXITCODE)
    exit $LASTEXITCODE
}
