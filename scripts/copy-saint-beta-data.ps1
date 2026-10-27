# FILE: copy-saint-beta-data.ps1
# Purpose: One-time move from Saint Beta to Saint (Stable) on Windows: copies
#          %USERPROFILE%\.saint-beta\userdata into %USERPROFILE%\.saint\userdata and keeps
#          the Stable data it replaces as a backup. Same rules as copy-saint-beta-data.sh.
# Usage: quit Saint Beta and Saint, then in PowerShell:
#        powershell -ExecutionPolicy Bypass -File .\copy-saint-beta-data.ps1

$ErrorActionPreference = "Stop"

$betaHome = if ($env:SAINT_BETA_HOME) { $env:SAINT_BETA_HOME } else { Join-Path $HOME ".saint-beta" }
$targetHome = if ($env:SAINT_HOME) { $env:SAINT_HOME } else { Join-Path $HOME ".saint" }
$source = Join-Path $betaHome "userdata"
$target = Join-Path $targetHome "userdata"

# Runtime entries of one install, never user data (same list as betaImport.ts).
$excluded = @("logs", "diagnostics", "environment-id", "device-boot-ownership.json",
  "server-runtime.json", "quit-resume.json", "import-requested.json", "import-result.json",
  "state.sqlite-shm")

if (-not (Test-Path (Join-Path $source "state.sqlite"))) {
  throw "No Saint Beta data at $source."
}
if ((Get-Item $source).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "$source must not be a link."
}
# The database is only consistent on disk while no app has it open.
if (Get-Process -Name "Saint", "Saint Beta" -ErrorAction SilentlyContinue) {
  throw "Saint or Saint Beta is still running. Quit both, then run this again."
}

New-Item -ItemType Directory -Force -Path $targetHome | Out-Null
if (Test-Path $target) {
  $backup = "$target.before-beta-copy-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Move-Item $target $backup
  Write-Host "==> Kept the previous Saint data at $backup"
}

$staging = Join-Path $targetHome (".beta-copy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Get-ChildItem -Force $source | Where-Object { $excluded -notcontains $_.Name } | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName (Join-Path $staging $_.Name)
  }
  Move-Item $staging $target
} finally {
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
}

Write-Host "==> Copied Saint Beta data into $target. Open Saint to continue where Beta left off."
