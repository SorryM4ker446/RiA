param(
    [switch]$Preview,
    [switch]$CheckPreview
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'installer'
$work = Join-Path $root '.desktop-data/setup-build'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Invoke-BuildTool([string]$Tool, [string[]]$ToolArguments) {
    & $Tool @ToolArguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}

function Get-Sha256([string]$Path) {
    $file = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($file)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $file.Dispose() }
}

$common = @(
    '/nologo', '/codepage:65001', '/optimize+', '/warnaserror+',
    ('/reference:' + (Join-Path $framework 'WPF/PresentationFramework.dll')),
    ('/reference:' + (Join-Path $framework 'WPF/PresentationCore.dll')),
    ('/reference:' + (Join-Path $framework 'WPF/WindowsBase.dll')),
    ('/reference:' + (Join-Path $framework 'System.Xaml.dll')),
    '/reference:System.Windows.Forms.dll',
    ('/resource:' + (Join-Path $source 'Setup.xaml') + ',Setup.xaml'),
    ('/resource:' + (Join-Path $root 'assets/desktop-icon.png') + ',RiA-icon.png')
)
$windowSource = Join-Path $source 'SetupWindow.cs'
if ($Preview -or $CheckPreview) {
    $output = Join-Path $work 'RiA-Setup-Preview.exe'
    Invoke-BuildTool $compiler ($common + @('/target:winexe', "/out:$output",
        ('/reference:' + (Join-Path $framework 'WPF/UIAutomationProvider.dll')),
        $windowSource, (Join-Path $source 'SetupPreview.cs')))
    if ($CheckPreview) {
        $capture = Join-Path $work ('preview-check-' + [guid]::NewGuid().ToString('N'))
        $check = Start-Process -FilePath $output -ArgumentList ('"' + $capture + '"') -WindowStyle Hidden -PassThru
        if (!$check.WaitForExit(15000)) {
            Stop-Process -Id $check.Id -Force -ErrorAction SilentlyContinue
            throw 'Installer window checks did not finish.'
        }
        if ($check.ExitCode -ne 0) { throw "Installer window checks failed. See $capture." }
        Write-Output $capture
    }
    Write-Output $output
    return
}

$package = Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Setup requires a three-part numeric release version.' }
$artifacts = Join-Path $root 'out/make/wix/x64'
$msi = Join-Path $artifacts "RiA-$($package.version)-x64.msi"
if (!(Test-Path -LiteralPath $msi -PathType Leaf)) {
    throw "Build the MSI for $($package.version) with npm run desktop:make first."
}
$verification = Get-Content -Raw (Join-Path $artifacts 'verification.json') | ConvertFrom-Json
$msiRecord = @($verification.artifacts | Where-Object filename -eq ([IO.Path]::GetFileName($msi)))
if ($verification.version -ne $package.version -or $msiRecord.Count -ne 1 -or
    (Get-Item -LiteralPath $msi).Length -ne $msiRecord[0].bytes -or
    (Get-Sha256 $msi) -ne $msiRecord[0].sha256) {
    throw 'The MSI differs from its recorded build checksum.'
}
$upgradeCode = & node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { windowsInstallerConfig } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(windowsInstallerConfig.upgradeCode)" (Join-Path $PSScriptRoot 'windows-installer-config.mjs')
if ($LASTEXITCODE -ne 0 -or $upgradeCode -notmatch '^[0-9A-Fa-f-]{36}$') { throw 'Could not read the MSI upgrade code.' }
$upgradeCode = [guid]::Parse($upgradeCode).ToString('B').ToUpperInvariant()
$buildInfo = Join-Path $work 'SetupBuild.cs'
$msiName = [IO.Path]::GetFileName($msi)
$hash = $msiRecord[0].sha256
[IO.File]::WriteAllText($buildInfo, @"
using System;
using System.Reflection;
[assembly: AssemblyTitle("RiA Setup")]
[assembly: AssemblyProduct("RiA")]
[assembly: AssemblyVersion("$($package.version).0")]
[assembly: AssemblyFileVersion("$($package.version).0")]
namespace RiA.Installer
{
    internal static class SetupBuild
    {
        public static readonly Version Version = new Version("$($package.version)");
        public const string UpgradeCode = "$upgradeCode";
        public const string PackageName = "$msiName";
        public const string PackageHash = "$hash";
    }
}
"@)
$filename = "RiA-Setup-$($package.version)-x64.exe"
$candidate = Join-Path $work $filename
Invoke-BuildTool $compiler ($common + @('/target:winexe', '/platform:x64', "/out:$candidate",
    ('/win32icon:' + (Join-Path $root 'assets/desktop-icon.ico')),
    ('/win32manifest:' + (Join-Path $source 'Setup.manifest')),
    "/resource:$msi,RiA.msi", $windowSource, $buildInfo,
    (Join-Path $source 'SetupProgram.cs'), (Join-Path $source 'StagedPackage.cs'), (Join-Path $source 'WindowsInstaller.cs')))
$checkRoot = Join-Path $work ('unrelated-install-' + [guid]::NewGuid().ToString('N'))
$checkLog = Join-Path $work 'setup-check.log'
$priorUpdateRoot = $env:RIA_SETUP_UPDATE_ROOT
try {
    $payloadCheck = Start-Process -FilePath $candidate -ArgumentList '-verify-payload' -WindowStyle Hidden -PassThru
    if (!$payloadCheck.WaitForExit(20000)) {
        Stop-Process -Id $payloadCheck.Id -Force -ErrorAction SilentlyContinue
        throw 'Setup did not finish checking its embedded MSI.'
    }
    if ($payloadCheck.ExitCode -ne 0) { throw 'Setup does not embed the verified standalone MSI.' }
    if (Test-Path -LiteralPath $checkLog) { Remove-Item -LiteralPath $checkLog }
    # Exercise the real Setup without allowing it to install.
    $env:RIA_SETUP_UPDATE_ROOT = $checkRoot
    $check = Start-Process -FilePath $candidate -ArgumentList ('-passive -norestart -log "' + $checkLog + '"') -WindowStyle Hidden -PassThru
    if (!$check.WaitForExit(20000)) {
        Stop-Process -Id $check.Id -Force -ErrorAction SilentlyContinue
        throw "Setup did not exit after refusing an unrelated update path. See $checkLog."
    }
    if ($check.ExitCode -ne 1603 -or
        !(Test-Path -LiteralPath $checkLog) -or
        !(Select-String -LiteralPath $checkLog -SimpleMatch 'The installed MSI directory does not match the requested update directory.' -Quiet)) {
        throw "Setup failed its non-installing update handoff check. See $checkLog."
    }
}
finally {
    $env:RIA_SETUP_UPDATE_ROOT = $priorUpdateRoot
}
$output = Join-Path $artifacts $filename
Copy-Item -LiteralPath $candidate -Destination $output
$hash = Get-Sha256 $output
[IO.File]::WriteAllText("$output.sha256", "$hash  $filename" + [Environment]::NewLine)
$verification.artifacts = @($msiRecord[0], [ordered]@{
    filename = $filename
    bytes = (Get-Item -LiteralPath $output).Length
    sha256 = $hash
})
$verificationPath = Join-Path $artifacts 'verification.json'
$verificationTemp = "$verificationPath.setup-tmp"
[IO.File]::WriteAllText($verificationTemp, (ConvertTo-Json -InputObject $verification -Depth 8) + [Environment]::NewLine)
[IO.File]::Replace($verificationTemp, $verificationPath, [NullString]::Value)
Write-Output $output
