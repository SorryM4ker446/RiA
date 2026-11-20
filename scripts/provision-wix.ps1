$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolDirectory = Join-Path $repositoryRoot '.desktop-data/tooling/wix-3.14.1'
$archive = Join-Path $repositoryRoot '.desktop-data/tooling/wix314-binaries.zip'
$expectedHash = '6AC824E1642D6F7277D0ED7EA09411A508F6116BA6FAE0AA5F2C7DAA2FF43D31'
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip' -OutFile $archive
}
$stream = [System.IO.File]::OpenRead($archive)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $actualHash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
} finally {
    $stream.Dispose()
    $sha256.Dispose()
}
if ($actualHash -ne $expectedHash) {
    throw 'WiX archive checksum mismatch. Remove the invalid archive and retry.'
}
# CI can expose the PowerShell 7 Archive module to Windows PowerShell 5.1.
$tar = Join-Path ([Environment]::GetFolderPath('System')) 'tar.exe'
& $tar -xf $archive -C $toolDirectory
if ($LASTEXITCODE -ne 0) {
    throw "WiX archive extraction failed (tar.exe exit code $LASTEXITCODE)."
}
foreach ($name in @('candle.exe', 'light.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $toolDirectory $name) -PathType Leaf)) {
        throw "WiX archive extraction did not produce $name in $toolDirectory."
    }
}
Write-Output "WiX 3.14.1 is ready at $toolDirectory"
