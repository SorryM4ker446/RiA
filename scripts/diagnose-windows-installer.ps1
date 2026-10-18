param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
# Read-only diagnostics. Never launch an installer or modify filesystem ACLs.
if (-not [System.IO.Path]::IsPathRooted($InstallDirectory)) { throw 'Use an absolute installation directory' }
$target = [System.IO.Path]::GetFullPath($InstallDirectory)
$volumeRoot = [System.IO.Path]::GetPathRoot($target)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)

function Read-PathSecurity([string]$Path) {
    $result = [ordered]@{ path = $Path; exists = $null; owner = $null; securityReadable = $false; error = $null }
    try {
        $result.exists = Test-Path -LiteralPath $Path -ErrorAction Stop
        if ($result.exists) {
            $result.owner = (Get-Acl -LiteralPath $Path -ErrorAction Stop).Owner
            $result.securityReadable = $true
        }
    } catch { $result.error = $_.Exception.Message }
    [pscustomobject]$result
}

$report = [ordered]@{
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    installDirectory = Read-PathSecurity $target
    volumeRoot = Read-PathSecurity $volumeRoot
    rollbackDirectory = Read-PathSecurity (Join-Path $volumeRoot 'Config.Msi')
    logPath = $null
    logFindings = @()
    note = 'Unreadable rollback security alone does not prove corruption. Correlate with the failing MSI action and execution context. No files, permissions or registry settings were changed.'
}
if ($LogPath) {
    $log = Get-Item -LiteralPath $LogPath -ErrorAction Stop
    if ($log.PSIsContainer -or $log.Length -gt 64MB) { throw 'Select an MSI log file no larger than 64 MiB' }
    $report.logPath = $log.FullName
    # Include only relevant diagnostics; never dump arbitrary property values.
    $report.logFindings = @(Select-String -LiteralPath $log.FullName -Pattern 'Error (?:1926|1303|1402)|Config\.Msi[^\r\n]*\.rbf|Return value 3|(?:ALLUSERS|MSIINSTALLPERUSER|Privileged|AdminUser)\s*[:=]' |
        Where-Object {
            $_.Line -notmatch '\bProperty\([CS]\):|\bPROPERTY CHANGE:' -or
            $_.Line -match '\bProperty\([CS]\): (?:ALLUSERS|MSIINSTALLPERUSER|Privileged|AdminUser) = [0-9]*\s*$'
        } |
        Select-Object -First 40 | ForEach-Object { [pscustomobject]@{ line = $_.LineNumber; text = $_.Line.Substring(0, [Math]::Min(600, $_.Line.Length)) } })
}
$report | ConvertTo-Json -Depth 5
