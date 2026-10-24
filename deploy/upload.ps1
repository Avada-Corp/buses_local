<#
    Заливка страницы расписания на сервер по SSH (Windows, PowerShell).

    Примеры:
        .\deploy\upload.ps1 -Server 203.0.113.10
        .\deploy\upload.ps1 -Server 203.0.113.10 -User root -RemoteDir /var/www/berezovka
        .\deploy\upload.ps1 -Server 203.0.113.10 -KeyFile C:\Users\me\.ssh\id_ed25519 -StartServer
        .\deploy\upload.ps1 -Server 203.0.113.10 -RemoteDir /var/www/html/bus -Only data.js

    Нужен клиент OpenSSH (в Windows 10/11 уже есть: ssh, scp).
    Скрипт только копирует файлы; сервер после -StartServer просто запускает
    python3 -m http.server на порту 8423 (удобно, чтобы сразу проверить).
#>
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$User = "root",
    [int]$SshPort = 22,
    [string]$RemoteDir = "/var/www/berezovka",
    [string]$KeyFile = "",
    [string[]]$Only = @("index.html", "data.js", "manifest.json", "sw.js", "icons"),
    [switch]$StartServer,
    [int]$HttpPort = 8423
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

foreach ($cmd in @("ssh", "scp")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "не найден $cmd — установите клиент OpenSSH (Параметры → Дополнительные компоненты)"
    }
}

$target = "$User@$Server"
$common = @("-P", "$SshPort")
if ($KeyFile) { $common += @("-i", $KeyFile) }
$sshCommon = @("-p", "$SshPort")
if ($KeyFile) { $sshCommon += @("-i", $KeyFile) }

Write-Host "сервер: $target ($RemoteDir), порт ssh $SshPort" -ForegroundColor Cyan

& ssh @sshCommon $target "mkdir -p '$RemoteDir'"
if ($LASTEXITCODE -ne 0) { throw "ssh не смог подключиться к $target" }

foreach ($name in $Only) {
    $local = Join-Path $root $name
    if (-not (Test-Path $local)) { throw "нет файла $local" }
    $item = Get-Item $local
    $scpArgs = @($common)
    if ($item.PSIsContainer) {
        $n = (Get-ChildItem $local -Recurse -File).Count
        Write-Host ("  -> {0}/ ({1} файл(ов))" -f $name, $n)
        $scpArgs += "-r"
    } else {
        Write-Host ("  -> {0} ({1} КБ)" -f $name, [math]::Round($item.Length / 1KB, 1))
    }
    & scp @scpArgs $local "${target}:$RemoteDir/"
    if ($LASTEXITCODE -ne 0) { throw "scp не смог скопировать $name" }
}

Write-Host "готово. Открывать: http://${Server}:$HttpPort/" -ForegroundColor Green

if ($StartServer) {
    Write-Host "запускаю python http.server на сервере..." -ForegroundColor Cyan
    $cmd = "cd '$RemoteDir' && (pkill -f 'http.server $HttpPort' || true) && " +
           "nohup python3 -m http.server $HttpPort --bind 0.0.0.0 > /tmp/berezovka-http.log 2>&1 & sleep 1; ss -tlnp | grep $HttpPort || true"
    & ssh @sshCommon $target $cmd
    Write-Host "проверьте: http://${Server}:$HttpPort/" -ForegroundColor Green
    Write-Host "если не открывается — откройте порт: sudo ufw allow $HttpPort/tcp" -ForegroundColor Yellow
}
