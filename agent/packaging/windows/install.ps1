# Installs the SSV Tally Connector as a Windows service. Run install.cmd (it asks for admin rights).
#
#   Program:  C:\Program Files\SSV Agent            (ssv-agent.exe, SSVAgentService.exe)
#   Config:   C:\ProgramData\SSVConnector\.env      (readable by Administrators and SYSTEM only)
#   Data:     C:\ProgramData\SSVConnector\data      (the agent's store)
#   Logs:     C:\ProgramData\SSVConnector\logs\agent.log
#
# Re-running it upgrades: the service is stopped, the program replaced, the config and data kept.

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$target = Join-Path $env:ProgramFiles "SSV Agent"
$config = Join-Path $env:ProgramData "SSVConnector"
$service = "SSVAgent"

function Say($text) { Write-Host "  $text" }

Write-Host "SSV Tally Connector - install"
foreach ($f in "ssv-agent.exe", "SSVAgentService.exe") {
    if (-not (Test-Path (Join-Path $src $f))) { throw "$f is missing next to install.ps1. Unzip the whole package first." }
}

# 1. Stop an installed copy, and any agent started by hand (two agents would clash on the local API port).
$existing = Get-Service -Name $service -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne "Stopped") { Say "stopping the running service"; Stop-Service $service -Force; Start-Sleep -Seconds 2 }
$manual = Get-Process ssv-agent -ErrorAction SilentlyContinue
if ($manual) { Say "closing ssv-agent.exe started by hand (pid $($manual.Id -join ', '))"; $manual | Stop-Process -Force }

# 2. Program files.
New-Item -ItemType Directory -Force $target | Out-Null
foreach ($f in "ssv-agent.exe", "SSVAgentService.exe", "README.txt", "START-HERE.txt", ".env.example", "uninstall.cmd", "uninstall.ps1") {
    if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) $target -Force }
}
Say "program files in $target"

# 3. Config folder, closed to ordinary users: the .env holds the agent secret.
New-Item -ItemType Directory -Force $config, (Join-Path $config "data"), (Join-Path $config "logs") | Out-Null
& icacls $config /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
Say "config folder $config (Administrators and SYSTEM only)"

$envFile = Join-Path $config ".env"
if (-not (Test-Path $envFile)) {
    if (Test-Path (Join-Path $src ".env")) {
        Copy-Item (Join-Path $src ".env") $envFile
        Say "settings copied from the package's .env"
    } else {
        Copy-Item (Join-Path $src ".env.example") $envFile
        Say "no .env in the package: enter the settings on the setup page when it opens"
    }
} else {
    Say "existing settings kept: $envFile"
}

# The setup page's password is LOCAL_API_TOKEN. Create one if the settings have none.
# Read and write UTF-8 without a BOM: a BOM would hide the first setting from the agent.
$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [System.IO.File]::ReadAllLines($envFile, $utf8)
$newPassword = $null
if (-not ($lines | Where-Object { $_ -match '^\s*LOCAL_API_TOKEN\s*=\s*\S' })) {
    $alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $chars = $bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] }
    $newPassword = (-join $chars[0..3]) + "-" + (-join $chars[4..7]) + "-" + (-join $chars[8..11]) + "-" + (-join $chars[12..15])
    $lines = @($lines | Where-Object { $_ -notmatch '^\s*LOCAL_API_TOKEN\s*=' }) + "LOCAL_API_TOKEN=$newPassword"
    [System.IO.File]::WriteAllLines($envFile, $lines, $utf8)
    Say "setup page password created"
}
$port = 4100
$portLine = $lines | Where-Object { $_ -match '^\s*LOCAL_PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($portLine -match '=\s*(\d+)') { $port = [int]$Matches[1] }
$setupUrl = "http://127.0.0.1:$port/"

# 4. Keep the store of an agent that ran by hand before, so it does not read Tally from scratch again.
$dataDir = Join-Path $config "data"
$oldData = Join-Path $env:APPDATA "SSVConnector\data"
if (-not (Get-ChildItem $dataDir -Filter *.db -ErrorAction SilentlyContinue) -and (Get-ChildItem $oldData -Filter *.db -ErrorAction SilentlyContinue)) {
    Copy-Item (Join-Path $oldData "*") $dataDir -Recurse -Force
    Say "moved the existing agent store from $oldData"
}

# 5. The service: starts with Windows (delayed, so TallyPrime and the network come first), restarts on failure.
$bin = "`"$(Join-Path $target 'SSVAgentService.exe')`""
if (-not $existing) {
    New-Service -Name $service -BinaryPathName $bin -DisplayName "SSV Tally Connector" -StartupType Automatic `
        -Description "Sends this distributor's TallyPrime sales and stock to the principal's ERPNext (SSV)." | Out-Null
    Say "service $service created"
} else {
    & sc.exe config $service binPath= $bin | Out-Null
}
& sc.exe config $service start= delayed-auto | Out-Null
& sc.exe failure $service reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null

Start-Service $service
Start-Sleep -Seconds 8
$state = (Get-Service $service).Status
Say "service is $state"
$log = Join-Path $config "logs\agent.log"
if (Test-Path $log) { Write-Host ""; Write-Host "Last lines of $($log):"; Get-Content $log -Tail 8 | ForEach-Object { Say $_ } }
# A desktop shortcut for everyone on this PC to the setup page.
$shortcut = Join-Path $env:PUBLIC "Desktop\SSV Agent Setup.url"
Set-Content -Path $shortcut -Value "[InternetShortcut]`r`nURL=$setupUrl" -Encoding ASCII
Say "desktop shortcut: SSV Agent Setup"

Write-Host ""
Write-Host "Done. The agent now runs in the background and starts with Windows."
Write-Host "Keep TallyPrime open with the distributor's company. Check it in ERPNext: SSV Distributor > Agent section."
Write-Host ""
Write-Host "Setup page: $setupUrl"
if ($newPassword) {
    Write-Host "Setup page password: $newPassword   (write it down; it is also LOCAL_API_TOKEN in $envFile)"
} else {
    Write-Host "Setup page password: LOCAL_API_TOKEN in $envFile (open it as an administrator)"
}
Start-Process $setupUrl
