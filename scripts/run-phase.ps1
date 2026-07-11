param(
    [Parameter(Mandatory = $true)]
    [string]$PromptFile
)

$ErrorActionPreference = "Stop"

# Resolve prompt file path relative to project root (execution directory)
if (-not (Test-Path $PromptFile)) {
    Write-Error "Prompt file not found: $PromptFile"
    exit 1
}

$content = Get-Content -Raw -Path $PromptFile
$tmpFile = Join-Path $env:TEMP "opencode-design-prompt-$([DateTime]::Now.Ticks).txt"
Set-Content -Path $tmpFile -Value $content -Encoding UTF8

Write-Host "[run-phase] Running opencode design phase from: $PromptFile"

# Track the child opencode process so we can kill its tree on exit.
# Without this, when execute-phases.ts times out the parent powershell, the
# `opencode run` child survives as an orphan and keeps editing files.
$childPid = $null

function Kill-ChildTree {
    param([int]$pidToKill)
    if (-not $pidToKill) { return }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidToKill" -ErrorAction SilentlyContinue
        if (-not $proc) { return }
        # Kill descendants first, then the process itself.
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $pidToKill" -ErrorAction SilentlyContinue |
            ForEach-Object { Kill-ChildTree -pidToKill $_.ProcessId }
        $proc | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue
    } catch {
        # best-effort cleanup
    }
}

# Ensure cleanup runs even if this script is killed by a timeout signal.
$cleanup = { Kill-ChildTree -pidToKill $childPid }
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanup | Out-Null
trap { Kill-ChildTree -pidToKill $childPid; break }

try {
    # Launch opencode as a tracked process (DeepSeek V4 Flash Free, high reasoning mode)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "opencode"
    $psi.Arguments = "run `"$tmpFile`" --model opencode/deepseek-v4-flash-free --variant high --auto"
    $psi.UseShellExecute = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $childPid = $proc.Id

    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
} finally {
    Kill-ChildTree -pidToKill $childPid
    Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
    Write-Error "[run-phase] opencode exited with code $exitCode"
}
exit $exitCode
