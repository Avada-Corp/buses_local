<#
    Сборка deploy/berezovka-site.zip — готового архива для панели хостинга.

    Пример:
        .\deploy\make-zip.ps1

    В архив попадают только файлы сайта (index.html, data.js, manifest.json, sw.js,
    icons/) и README.md. Служебные папки (_tools, fload_files), конфиги деплоя и
    скриншоты не включаются.

    Пути внутри архива пишутся с прямыми слэшами — так он корректно распаковывается
    и на Linux, а не только в Проводнике Windows.
#>
param(
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot "berezovka-site.zip" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @("index.html", "data.js", "manifest.json", "sw.js", "README.md")
$iconsDir = Join-Path $root "icons"
if (Test-Path $iconsDir) {
    $files += (Get-ChildItem $iconsDir -File | Sort-Object Name | ForEach-Object { "icons/" + $_.Name })
}

foreach ($rel in $files) {
    if (-not (Test-Path (Join-Path $root $rel))) { throw "нет файла $rel" }
}

if (Test-Path $OutFile) { Remove-Item $OutFile }

# без BOM/лишних метаданных: только сами файлы, пути через "/"
$zip = [System.IO.Compression.ZipFile]::Open($OutFile, "Create")
try {
    foreach ($rel in $files) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $root $rel), $rel, "Optimal")
    }
} finally {
    $zip.Dispose()
}

$size = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
Write-Host ("готово: {0} ({1} КБ, файлов: {2})" -f $OutFile, $size, $files.Count) -ForegroundColor Green
