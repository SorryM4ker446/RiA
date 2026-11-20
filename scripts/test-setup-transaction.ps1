param([switch]$PerMachine)

$ErrorActionPreference = 'Stop'
$scope = 'perUser'
$holder = 'LocalAppDataFolder'
$registry = 'HKCU'
if ($PerMachine) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'The per-machine rollback fixture requires an elevated shell on a disposable test runner.'
    }
    $scope = 'perMachine'
    $holder = 'ProgramFiles64Folder'
    $registry = 'HKLM'
}
$root = Split-Path -Parent $PSScriptRoot
$wix = Join-Path $root '.desktop-data/tooling/wix-3.14.1'
$test = Join-Path $root ('.desktop-data/setup-build/msi-test-' + [guid]::NewGuid().ToString('N'))
$temp = Join-Path $test 'temp'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $wix 'light.exe'))) {
    & (Join-Path $PSScriptRoot 'provision-wix.ps1')
}

function Invoke-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool returned $LASTEXITCODE. Evidence is in $test." }
}

$upgrade = [guid]::NewGuid().ToString('B')
$old = [guid]::NewGuid().ToString('B')
$new = [guid]::NewGuid().ToString('B')
$next = [guid]::NewGuid().ToString('B')

function Build-Fixture([string]$Version, [string]$Code, [string]$Marker, [int]$AdditionalFiles) {
    $package = Join-Path $test "RiA-$Version-x64.msi"
    $authoring = "$package.wxs"
    $object = "$package.wixobj"
    [IO.File]::WriteAllText((Join-Path $test "$Marker.txt"), $Version)
    $files = @("<File Id='Marker' Name='$Marker.txt' Source='$Marker.txt'/>")
    for ($i = 0; $i -lt $AdditionalFiles; $i++) {
        $file = "payload-$i.bin"
        $bytes = New-Object byte[] (3 * 1024 * 1024)
        [IO.File]::WriteAllBytes((Join-Path $test $file), $bytes)
        $files += "<File Id='Payload$i' Name='$file' Source='$file'/>"
    }
    $component = [guid]::NewGuid().ToString('B')
    [IO.File]::WriteAllText($authoring, @"
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="$Code" Name="RiA Installer Transaction Test $upgrade" Language="1033"
           Version="$Version" Manufacturer="RiA Tests" UpgradeCode="$upgrade">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="$scope" />
    <MajorUpgrade Schedule="afterInstallInitialize" DowngradeErrorMessage="A newer fixture is installed." />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="APPLICATIONROOTDIRECTORY" Secure="yes" />
    <Property Id="FIXTUREINSTALLPATH">
      <RegistrySearch Id="FindFixturePath" Root="$registry" Win64="yes"
                      Key="Software\RiA Installer Transaction Test\$Code" Name="InstallPath" Type="raw" />
    </Property>
    <SetDirectory Id="APPLICATIONROOTDIRECTORY" Value="[FIXTUREINSTALLPATH]" Sequence="execute">
      Installed AND FIXTUREINSTALLPATH
    </SetDirectory>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="$holder">
        <Directory Id="APPLICATIONROOTDIRECTORY" Name="RiA Installer Transaction Test">
          <Component Id="Payload" Guid="$component">
            $($files -join [Environment]::NewLine)
            <RegistryValue Root="$registry" Key="Software\RiA Installer Transaction Test\$Code" Name="InstallPath"
                           Type="string" Value="[APPLICATIONROOTDIRECTORY]" KeyPath="yes" />
            <RemoveFolder Id="RemoveTarget" On="uninstall" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Fixture" Title="Fixture" Level="1"><ComponentRef Id="Payload" /></Feature>
  </Product>
</Wix>
"@)
    Push-Location -LiteralPath $test
    try {
        Invoke-Tool (Join-Path $wix 'candle.exe') @('-nologo', '-arch', 'x64', '-out', $object, $authoring)
        Invoke-Tool (Join-Path $wix 'light.exe') @('-nologo', '-out', $package, $object)
    }
    finally { Pop-Location }
}

Build-Fixture '1.0.0' $old 'old' 0
Build-Fixture '2.0.0' $new 'new' 8
Build-Fixture '3.0.0' $next 'next' 0
$candidate = Join-Path $test 'RiA-2.0.0-x64.msi'
$hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
$info = Join-Path $test 'TestBuild.cs'
[IO.File]::WriteAllText($info, @"
namespace RiA.Installer
{
    internal static class SetupBuild
    {
        public const string PackageName = "RiA-2.0.0-x64.msi";
        public const string PackageHash = "$hash";
    }
}
"@)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$launcher = Join-Path $test 'TestSetupTransaction.exe'
Invoke-Tool $compiler @('/nologo', '/codepage:65001', '/warnaserror+', '/platform:x64',
    "/out:$launcher", "/resource:$candidate,RiA.msi", $info,
    (Join-Path $root 'installer/WindowsInstaller.cs'), (Join-Path $root 'installer/StagedPackage.cs'),
    (Join-Path $root 'tests/desktop/fixtures/SetupTransactionTest.cs'))
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    $env:TEMP = $env:TMP = $temp
    $location = Join-Path $test ('Test Install ' + [char]0x5B89)
    Invoke-Tool $launcher @((Join-Path $test 'RiA-1.0.0-x64.msi'), $location, $old, $new, $test, $scope,
        (Join-Path $test 'RiA-3.0.0-x64.msi'), $next)
}
finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
}
Write-Output $test
