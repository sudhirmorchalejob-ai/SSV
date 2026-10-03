# Removes the SSV Tally Connector service and program. Run uninstall.cmd (it asks for admin rights).
# The settings, store and logs in C:\ProgramData\SSVConnector are kept unless -Purge is given,
# so a reinstall carries on where it stopped.
param([switch]$Purge)

$ErrorActionPreference = "Stop"
$service = "SSVAgent"
$target = Join-Path $env:ProgramFiles "SSV Agent"
$config = Join-Path $env:ProgramData "SSVConnector"

$svc = Get-Service -Name $service -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne "Stopped") { Stop-Service $service -Force; Start-Sleep -Seconds 2 }
    & sc.exe delete $service | Out-Null
    Write-Host "  service removed"
}
if (Test-Path $target) {
    # This script (and the .cmd that started it) may be running from $target: leave those two.
    Get-ChildItem $target | Where-Object { $_.Name -notin @("uninstall.ps1", "uninstall.cmd") } | Remove-Item -Recurse -Force
    Write-Host "  program files removed from $target (delete the folder itself once this window is closed)"
}
$shortcut = Join-Path $env:PUBLIC "Desktop\SSV Agent Setup.url"
if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Host "  desktop shortcut removed" }
if ($Purge) {
    Remove-Item $config -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  settings, store and logs removed ($config)"
} else {
    Write-Host "  settings, store and logs kept in $config (uninstall.cmd -Purge removes them)"
}
