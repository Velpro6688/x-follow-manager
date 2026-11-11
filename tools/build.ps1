# build.ps1 - package the extension into dist/
# Usage: powershell -ExecutionPolicy Bypass -File tools/build.ps1
#
# 产出两个包，用途不同：
#   1) dist/x-follow-manager-v<ver>-store.zip   —— 商店上传用，manifest.json 在 ZIP 根目录
#   2) dist/x-follow-manager-v<ver>.zip          —— 手动安装用，保留一层文件夹（解压后直接「加载已解压」）
#
# Chrome 应用商店硬性要求：manifest.json 必须位于 ZIP 根目录。
# Compress-Archive -Path $src 会把目录本身打进去（多一层），直接用它会被商店拒收。

$ErrorPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "x-follow-manager"
$dist = Join-Path $root "dist"

if (-not (Test-Path (Join-Path $src "manifest.json"))) {
    throw "manifest.json not found in $src"
}

# Windows PowerShell 5.1 decodes UTF-8 without BOM as ANSI, so force UTF8 here.
$manifest = Get-Content (Join-Path $src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

New-Item -ItemType Directory -Force -Path $dist | Out-Null

# ---- 商店包：manifest.json 必须在根 ----
$storeZip = Join-Path $dist ("x-follow-manager-v" + $version + "-store.zip")
if (Test-Path $storeZip) { Remove-Item $storeZip -Force }
# 用 -Path "$src\*" 展开目录内容，保证根目录就是 manifest.json
$legal = @((Join-Path $root "LICENSE"), (Join-Path $root "NOTICE.md"))
$storeInputs = @((Join-Path $src "*")) + $legal
Compress-Archive -Path $storeInputs -DestinationPath $storeZip -CompressionLevel Optimal

# ---- 手动安装包：保留一层目录，解压后文件夹即为扩展目录 ----
$manualZip = Join-Path $dist ("x-follow-manager-v" + $version + ".zip")
if (Test-Path $manualZip) { Remove-Item $manualZip -Force }
$manualInputs = @($src) + $legal + @((Join-Path $root "PRIVACY.md"), (Join-Path $root "INSTALL.md"))
Compress-Archive -Path $manualInputs -DestinationPath $manualZip -CompressionLevel Optimal

foreach ($z in @($storeZip, $manualZip)) {
    $size = [math]::Round((Get-Item $z).Length / 1KB, 1)
    Write-Output ("built: " + $z + " (" + $size + " KB)")
}
