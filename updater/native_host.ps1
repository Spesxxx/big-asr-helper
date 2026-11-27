# Chrome Native Messaging Host for Big ASR Helper 1-Click Auto-Update (Windows PowerShell)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$DefaultUrl = "https://github.com/Spesxxx/big-asr-helper/releases/latest/download/big-asr-helper-extension.zip"
$AllowedPrefix = "https://github.com/Spesxxx/big-asr-helper/"

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Send-NativeMessage($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $lenBytes = [System.BitConverter]::GetBytes([int]$bytes.Length)
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

try {
    $lenBuf = New-Object byte[] 4
    $read = $stdin.Read($lenBuf, 0, 4)
    if ($read -lt 4) { exit 0 }
    $msgLen = [System.BitConverter]::ToInt32($lenBuf, 0)
    $msgBuf = New-Object byte[] $msgLen
    $offset = 0
    while ($offset -lt $msgLen) {
        $n = $stdin.Read($msgBuf, $offset, $msgLen - $offset)
        if ($n -le 0) { break }
        $offset += $n
    }
    $msg = [System.Text.Encoding]::UTF8.GetString($msgBuf) | ConvertFrom-Json

    if ($msg.action -eq "ping") {
        Send-NativeMessage @{ ok = $true; pong = $true }
        exit 0
    }

    if ($msg.action -ne "update") {
        Send-NativeMessage @{ ok = $false; error = "Unknown action" }
        exit 0
    }

    $url = if ($msg.download_url) { [string]$msg.download_url } else { $DefaultUrl }
    if (-not $url.StartsWith($AllowedPrefix)) {
        throw "Disallowed download URL: $url"
    }

    $rootDir = Split-Path -Parent $PSScriptRoot
    $extDir = Join-Path $rootDir "extension"
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("big_asr_update_" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        $zipPath = Join-Path $tmpDir "release.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 60

        $extractDir = Join-Path $tmpDir "extracted"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

        $newExt = Join-Path $extractDir "extension"
        $manifestPath = Join-Path $newExt "manifest.json"
        if (-not (Test-Path $manifestPath)) {
            throw "Missing extension/manifest.json in downloaded archive"
        }
        $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

        if (-not (Test-Path $extDir)) {
            New-Item -ItemType Directory -Path $extDir -Force | Out-Null
        }
        Copy-Item -Path (Join-Path $newExt "*") -Destination $extDir -Recurse -Force

        Send-NativeMessage @{ ok = $true; version = [string]$manifest.version }
    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
    Send-NativeMessage @{ ok = $false; error = $_.Exception.Message }
}
