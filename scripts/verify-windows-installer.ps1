$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$artifact = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot "out/make/wix/x64/RiA-$($package.version)-x64.msi")).Path
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
    $properties.ProductLanguage -ne '2052' -or $properties.MSIINSTALLPERUSER -ne '1') {
    throw 'MSI version, upgrade identity, language or installation scope is incorrect'
}
$selectable = @(Read-MsiTable 'Feature' | Where-Object { $_[6] -eq 'APPLICATIONROOTDIRECTORY' })
$browse = @(Read-MsiTable 'ControlEvent' | Where-Object { $_[0] -eq 'CustomizeDlg' -and $_[1] -eq 'Browse' -and $_[2] -eq 'SelectionBrowse' -and $_[3] -eq 'BrowseDlg' })
$purge = @(Read-MsiTable 'CustomAction' | Where-Object { $_[0] -match 'RemoveFolderEx' })
if ($selectable.Count -ne 1 -or $browse.Count -ne 1 -or $purge.Count -ne 0) {
    throw 'Compiled MSI directory selection or uninstall safety is incorrect'
}
Write-Output "Verified compiled MSI version, Chinese directory selection, per-user scope and uninstall actions: $artifact"
