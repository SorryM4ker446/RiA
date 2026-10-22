param([string]$Artifact)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $Artifact) { $Artifact = Join-Path $repositoryRoot "out/make/wix/x64/RiA-$($package.version)-x64.msi" }
$artifact = (Resolve-Path -LiteralPath $Artifact).Path
$configJson = & node --input-type=module -e "import { windowsInstallerConfig } from './scripts/windows-installer-config.mjs'; console.log(JSON.stringify(windowsInstallerConfig))"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read installer configuration' }
$config = $configJson | ConvertFrom-Json
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($artifact, 0))

function Read-MsiTable([string]$table) {
    $sql = 'SELECT * FROM `' + $table + '`'
    $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @($sql))
    try {
        $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
        while ($record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)) {
            $count = $record.GetType().InvokeMember('FieldCount', 'GetProperty', $null, $record, $null)
            $values = for ($index = 1; $index -le $count; $index++) {
                $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @($index))
            }
            ,$values
        }
    } finally {
        $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    }
}

$properties = @{}
Read-MsiTable 'Property' | ForEach-Object { $properties[$_[0]] = $_[1] }
if ($properties.ProductVersion -ne "$($package.version).0" -or
    $properties.UpgradeCode -ne "{$($config.upgradeCode)}" -or
    $properties.ProductLanguage -ne '2052' -or $properties.ALLUSERS -ne '1' -or $properties.MSIINSTALLPERUSER -ne '0' -or
    $properties.MsiLogging -ne 'voicewarmup') {
    throw 'MSI version, upgrade identity, language, installation scope or default logging is incorrect'
}
# Registry roots: 1 = HKEY_CURRENT_USER, 2 = HKEY_LOCAL_MACHINE.
$perUserSearch = @(Read-MsiTable 'RegLocator' | Where-Object { $_[0] -eq 'PerUserRiaMarker' -and $_[1] -eq '1' -and $_[2] -eq 'Software\Microsoft\RiA' -and $_[3] -eq 'installed' })
$refusal = @(Read-MsiTable 'LaunchCondition' | Where-Object { $_[0] -eq 'Installed OR WIX_UPGRADE_DETECTED OR NOT PERUSERRIA' })
# Upgrade columns: UpgradeCode, VersionMin, VersionMax, Language, Attributes, Remove, ActionProperty.
$upgradeSearch = @(Read-MsiTable 'Upgrade' | Where-Object { $_[0] -eq "{$($config.upgradeCode)}" -and $_[6] -eq 'WIX_UPGRADE_DETECTED' })
if ($perUserSearch.Count -ne 1 -or $refusal.Count -ne 1 -or $upgradeSearch.Count -ne 1) {
    throw 'Compiled MSI per-user installation refusal is incorrect'
}
$selectable = @(Read-MsiTable 'Feature' | Where-Object { $_[6] -eq 'APPLICATIONROOTDIRECTORY' })
$browse = @(Read-MsiTable 'ControlEvent' | Where-Object { $_[0] -eq 'CustomizeDlg' -and $_[1] -eq 'Browse' -and $_[2] -eq 'SelectionBrowse' -and $_[3] -eq 'BrowseDlg' })
$purge = @(Read-MsiTable 'CustomAction' | Where-Object { $_[0] -match 'RemoveFolderEx' })
if ($selectable.Count -ne 1 -or $browse.Count -ne 1 -or $purge.Count -ne 0) {
    throw 'Compiled MSI directory selection or uninstall safety is incorrect'
}
$responseCache = @(Read-MsiTable 'Directory' | Where-Object { $_[2] -match '(^|\|)route-cache$' })
if ($responseCache.Count -ne 0) {
    throw 'Compiled MSI contains regenerable Next.js response caches'
}
Write-Output "Verified compiled MSI version, Chinese directory selection, per-machine scope, per-user installation refusal, default logging and uninstall actions: $artifact"
