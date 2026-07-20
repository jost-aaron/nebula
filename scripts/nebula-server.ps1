[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "init", "validate", "up", "start", "down", "stop", "status", "logs", "update", "upgrade", "backup", "help")]
  [string]$Command = "help",
  [string]$BaseDir,
  [string]$EnvFile,
  [string]$ComposeFile,
  [ValidateRange(1, 65535)]
  [int]$Port = 5173,
  [ValidatePattern("^(?:[0-9A-Fa-f:.]+|localhost)$")]
  [string]$BindAddress = "127.0.0.1",
  [ValidatePattern("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")]
  [string]$TailscaleHostname = "nebula",
  [string]$TailscaleFqdn = "",
  [switch]$Tailscale,
  [ValidateRange(1, 3600)]
  [int]$TimeoutSeconds = 180,
  [switch]$NoWait,
  [switch]$Follow,
  [ValidateRange(0, 100000)]
  [int]$Tail = 200,
  [string]$BackupId = "",
  [string]$TokenFile = "",
  [string]$DockerBin = "docker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) {
  throw "nebula-server.ps1 requires PowerShell 7 or newer on Windows. Use nebula-server.sh on Linux or macOS."
}

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($BaseDir)) {
  $BaseDir = if ($env:NEBULA_SERVER_BASE_DIR) { $env:NEBULA_SERVER_BASE_DIR } else { Join-Path $env:LOCALAPPDATA "Nebula" }
}
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = if ($env:NEBULA_SERVER_ENV_FILE) { $env:NEBULA_SERVER_ENV_FILE } else { Join-Path $RepositoryRoot ".env" }
}
if ([string]::IsNullOrWhiteSpace($ComposeFile)) {
  $ComposeFile = if ($env:NEBULA_SERVER_COMPOSE_FILE) { $env:NEBULA_SERVER_COMPOSE_FILE } else { Join-Path $RepositoryRoot "compose.deploy.yaml" }
}

$BaseDir = [IO.Path]::GetFullPath($BaseDir)
$EnvFile = [IO.Path]::GetFullPath($EnvFile)
$ComposeFile = [IO.Path]::GetFullPath($ComposeFile)
$ComposeArguments = @("compose", "--env-file", $EnvFile, "-f", $ComposeFile)

function Write-Note([string]$Message) {
  Write-Host "nebula-server: $Message"
}

function Stop-WithError([string]$Message) {
  throw "nebula-server: error: $Message"
}

function Show-Usage {
  @"
Nebula single-host server operator for Windows

Usage:
  .\scripts\nebula-server.ps1 <command> [options]

Commands:
  install          Initialize safely, build, start, wait, and print setup URL
  init             Create missing directories and .env without overwriting it
  validate         Check prerequisites, configuration, and deployment Compose
  up | start       Validate, build if needed, start, and wait for readiness
  down | stop      Gracefully stop the deployment stack
  status           Show deployment container status
  logs             Show deployment logs; add -Follow to stream
  update | upgrade Rebuild the checked-out revision with fresh base images
  backup           Create an online backup using -TokenFile
  help             Show this help

Common options:
  -BaseDir PATH           Storage root (default: %LOCALAPPDATA%\Nebula)
  -EnvFile PATH           Deployment env file (default: repository .env)
  -ComposeFile PATH       Deployment Compose file
  -BindAddress ADDRESS    Host bind address (default: 127.0.0.1)
  -Port PORT              Host port (default: 5173)
  -Tailscale              Validate private Tailscale Serve requirements
  -TailscaleHostname NAME Generic Tailscale machine name
  -TailscaleFqdn HOST     Exact assigned *.ts.net hostname
  -NoWait                 Do not wait for readiness

The CLI never replaces an existing env file, changes Git revisions, removes
volumes, resets accounts, or prints tokens. Run it from a reviewed checkout.
"@
}

function Invoke-Docker([string[]]$Arguments) {
  & $DockerBin @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError "Docker command failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Compose([string[]]$Arguments) {
  Invoke-Docker ($ComposeArguments + $Arguments)
}

function Test-Prerequisites {
  if (-not (Get-Command $DockerBin -ErrorAction SilentlyContinue)) {
    Stop-WithError "Docker is not installed or '$DockerBin' is not on PATH"
  }
  & $DockerBin info *> $null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker Desktop is unavailable" }
  & $DockerBin compose version *> $null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker Compose v2 is unavailable" }
  if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
    Stop-WithError "Compose file not found: $ComposeFile"
  }
}

function ConvertTo-DockerPath([string]$Path) {
  return ([IO.Path]::GetFullPath($Path) -replace "\\", "/")
}

function ConvertTo-EnvValue([string]$Value) {
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Protect-PrivatePath([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $Path /inheritance:r /grant:r "${identity}:(F)" *> $null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "cannot restrict ACLs for $Path" }
}

function Test-PrivateAcl([string]$Path) {
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Stop-WithError "private path cannot be a reparse point: $Path"
  }
  $broadSids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545")
  $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor
    [Security.AccessControl.FileSystemRights]::Modify -bor
    [Security.AccessControl.FileSystemRights]::FullControl
  foreach ($entry in (Get-Acl -LiteralPath $Path).Access) {
    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -in $broadSids -and ($entry.FileSystemRights -band $writeRights)) {
      Stop-WithError "private path grants broad write access: $Path"
    }
  }
}

function Initialize-Deployment {
  if (Test-Path -LiteralPath $EnvFile) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { Stop-WithError "env path is not a regular file: $EnvFile" }
    Write-Note "keeping existing configuration: $EnvFile"
    return
  }

  $paths = @{
    Data = Join-Path $BaseDir "data"
    Content = Join-Path $BaseDir "content"
    Backups = Join-Path $BaseDir "backups"
    Tailscale = Join-Path $BaseDir "tailscale"
    TailscaleState = Join-Path $BaseDir "tailscale\state"
    TailscaleAuthKey = Join-Path $BaseDir "tailscale\authkey"
  }
  foreach ($directory in @($BaseDir, $paths.Data, $paths.Content, $paths.Backups, $paths.Tailscale, $paths.TailscaleState)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  Protect-PrivatePath $paths.Data
  Protect-PrivatePath $paths.Backups
  Protect-PrivatePath $paths.Tailscale
  Protect-PrivatePath $paths.TailscaleState
  if (-not (Test-Path -LiteralPath $paths.TailscaleAuthKey)) {
    New-Item -ItemType File -Path $paths.TailscaleAuthKey | Out-Null
  }
  Protect-PrivatePath $paths.TailscaleAuthKey

  $parent = Split-Path -Parent $EnvFile
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Stop-WithError "env file parent does not exist: $parent" }
  $temporary = "$EnvFile.tmp.$([guid]::NewGuid().ToString('N'))"
  $fqdn = $TailscaleFqdn.Trim().ToLowerInvariant()
  $lines = @(
    "# Generated by scripts/nebula-server.ps1. Review before exposing the server."
    "NEBULA_BIND_ADDRESS=$(ConvertTo-EnvValue $BindAddress)"
    "NEBULA_PORT=$(ConvertTo-EnvValue ([string]$Port))"
    'NEBULA_UID="1000"'
    'NEBULA_GID="1000"'
    "NEBULA_DATA_PATH=$(ConvertTo-EnvValue (ConvertTo-DockerPath $paths.Data))"
    "NEBULA_CONTENT_PATH=$(ConvertTo-EnvValue (ConvertTo-DockerPath $paths.Content))"
    "NEBULA_BACKUP_PATH=$(ConvertTo-EnvValue (ConvertTo-DockerPath $paths.Backups))"
    'NEBULA_REQUIRE_AUTH="false"'
    'NEBULA_API_TOKEN=""'
    'NEBULA_AUTH_ALLOW_LOCALHOST="false"'
    'NEBULA_FIRST_RUN_GUEST_ENABLED="false"'
    'NEBULA_GUEST_SESSION_TTL_MS="28800000"'
    'NEBULA_CORS_ALLOWED_ORIGINS=""'
    "NEBULA_VITE_ALLOWED_HOSTS=$(ConvertTo-EnvValue $fqdn)"
    'NEBULA_VITE_HMR="false"'
    'NEBULA_EXTERNAL_HTTPS="false"'
    "NEBULA_TAILSCALE_HOSTNAME=$(ConvertTo-EnvValue $TailscaleHostname)"
    "NEBULA_TAILSCALE_FQDN=$(ConvertTo-EnvValue $fqdn)"
    'NEBULA_TAILSCALE_UI_ENABLED="true"'
    'NEBULA_TAILSCALE_INTERACTIVE_LOGIN="true"'
    "NEBULA_TAILSCALE_STATE_PATH=$(ConvertTo-EnvValue (ConvertTo-DockerPath $paths.TailscaleState))"
    "NEBULA_TAILSCALE_AUTHKEY_FILE=$(ConvertTo-EnvValue (ConvertTo-DockerPath $paths.TailscaleAuthKey))"
    'TMDB_API_TOKEN=""'
    'GOOGLE_VISION_API_KEY=""'
    'NEBULA_AUDIT_RETENTION_DAYS="90"'
    'NEBULA_AUDIT_MAX_EVENTS="10000"'
  )
  try {
    [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
    Protect-PrivatePath $temporary
    [IO.File]::Move($temporary, $EnvFile)
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
  Write-Note "created configuration: $EnvFile"
}

function Get-DeploymentEnvironment {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Stop-WithError "configuration not found: $EnvFile (run init or install)"
  }
  Test-PrivateAcl $EnvFile
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$name] = $value.Replace('\"', '"').Replace('\\', '\')
    }
  }
  return $values
}

function Get-RequiredValue([hashtable]$Values, [string]$Name) {
  if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
    Stop-WithError "$Name is missing from $EnvFile"
  }
  return [string]$Values[$Name]
}

function Test-Storage([hashtable]$Values) {
  foreach ($name in @("NEBULA_DATA_PATH", "NEBULA_CONTENT_PATH", "NEBULA_BACKUP_PATH")) {
    $path = Get-RequiredValue $Values $name
    if (-not [IO.Path]::IsPathFullyQualified($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) {
      Stop-WithError "$name must be an existing absolute directory"
    }
  }
}

function Test-ExactTailscaleFqdn([string]$Value) {
  return $Value.Length -le 253 -and $Value -match '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){2,}ts\.net$'
}

function Test-TailscaleConfiguration([hashtable]$Values) {
  if (-not $Tailscale) { return }
  if (($Values["NEBULA_BIND_ADDRESS"] ?? "127.0.0.1") -ne "127.0.0.1") { Stop-WithError "Tailscale deployment requires NEBULA_BIND_ADDRESS=127.0.0.1" }
  if ($Values["NEBULA_AUTH_ALLOW_LOCALHOST"] -ne "false") { Stop-WithError "Tailscale deployment requires NEBULA_AUTH_ALLOW_LOCALHOST=false" }
  if ($Values["NEBULA_FIRST_RUN_GUEST_ENABLED"] -ne "false") { Stop-WithError "Tailscale deployment requires NEBULA_FIRST_RUN_GUEST_ENABLED=false" }
  if ($Values["NEBULA_VITE_HMR"] -ne "false") { Stop-WithError "Tailscale deployment requires NEBULA_VITE_HMR=false" }
  $fqdn = [string]($Values["NEBULA_TAILSCALE_FQDN"] ?? "")
  $allowed = [string]($Values["NEBULA_VITE_ALLOWED_HOSTS"] ?? "")
  if ($fqdn -or $allowed) {
    if (-not (Test-ExactTailscaleFqdn $allowed) -or $fqdn -ne $allowed) { Stop-WithError "Tailscale FQDN and allowed host must be the same exact *.ts.net hostname" }
  }
  $contentPath = [IO.Path]::GetFullPath((Get-RequiredValue $Values "NEBULA_CONTENT_PATH"))
  $statePath = [IO.Path]::GetFullPath((Get-RequiredValue $Values "NEBULA_TAILSCALE_STATE_PATH"))
  $authKeyPath = [IO.Path]::GetFullPath((Get-RequiredValue $Values "NEBULA_TAILSCALE_AUTHKEY_FILE"))
  if ($statePath.StartsWith($contentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $statePath -eq $contentPath) {
    Stop-WithError "Tailscale state must be outside NEBULA_CONTENT_PATH"
  }
  if (-not (Test-Path -LiteralPath $statePath -PathType Container)) { Stop-WithError "Tailscale state directory is missing" }
  if (-not (Test-Path -LiteralPath $authKeyPath -PathType Leaf)) { Stop-WithError "Tailscale auth-key file is missing" }
  Test-PrivateAcl $statePath
  Test-PrivateAcl $authKeyPath
  $stateHasFiles = [bool](Get-ChildItem -LiteralPath $statePath -Force | Select-Object -First 1)
  $authKeyHasValue = (Get-Item -LiteralPath $authKeyPath).Length -gt 0
  if (-not $stateHasFiles -and -not $authKeyHasValue -and ($Values["NEBULA_TAILSCALE_UI_ENABLED"] -ne "true" -or $Values["NEBULA_TAILSCALE_INTERACTIVE_LOGIN"] -ne "true")) {
    Stop-WithError "Tailscale first enrollment requires an auth-key file or explicit interactive UI mode"
  }
  $serveConfig = Get-Content -LiteralPath (Join-Path $RepositoryRoot "deploy\tailscale\serve.json") -Raw
  if ($serveConfig -notmatch '"Proxy"\s*:\s*"http://127\.0\.0\.1:5173"' -or $serveConfig -notmatch '"\$\{TS_CERT_DOMAIN\}:443"\s*:\s*false') {
    Stop-WithError "reviewed Tailscale Serve configuration is invalid"
  }
}

function Test-Deployment {
  $values = Get-DeploymentEnvironment
  Invoke-Compose @("config", "--quiet")
  Test-Storage $values
  Test-TailscaleConfiguration $values
  Write-Note "deployment configuration is valid"
  return $values
}

function Get-SetupUrl([hashtable]$Values) {
  $address = [string]($Values["NEBULA_BIND_ADDRESS"] ?? "127.0.0.1")
  if ($address -in @("0.0.0.0", "::")) { $address = "127.0.0.1" }
  $configuredPort = [string]($Values["NEBULA_PORT"] ?? "5173")
  return "http://${address}:$configuredPort"
}

function Wait-ForReadiness([hashtable]$Values) {
  if ($NoWait) { Write-Note "readiness wait skipped"; return }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  Write-Note "waiting up to ${TimeoutSeconds}s for readiness"
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    & $DockerBin @ComposeArguments exec -T dashboard wget -q -O /dev/null http://127.0.0.1:5173/readyz *> $null
    if ($LASTEXITCODE -eq 0) { Write-Note "server is ready: $(Get-SetupUrl $Values)"; return }
    Start-Sleep -Seconds 2
  }
  Invoke-Compose @("ps")
  Stop-WithError "server did not become ready within ${TimeoutSeconds}s"
}

function Start-Deployment([hashtable]$Values) {
  Invoke-Compose @("up", "-d", "--build")
  Wait-ForReadiness $Values
  Write-Note "owner setup URL: $(Get-SetupUrl $Values)"
  if ($Tailscale) { Write-Note "enable Tailscale in owner Settings / Remote Access, then inspect it with the Compose exec tailscale command" }
}

function New-OnlineBackup {
  $values = Get-DeploymentEnvironment
  if ([string]::IsNullOrWhiteSpace($TokenFile) -or -not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    Stop-WithError "backup requires an existing -TokenFile; never pass the token on the command line"
  }
  Test-PrivateAcl $TokenFile
  $token = [IO.File]::ReadAllText([IO.Path]::GetFullPath($TokenFile)).Trim()
  if ([string]::IsNullOrWhiteSpace($token) -or $token.Contains("`n") -or $token.Contains("`r")) { Stop-WithError "token file must contain exactly one non-empty line" }
  if ([string]::IsNullOrWhiteSpace($BackupId)) { $script:BackupId = "nebula-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))" }
  if ($BackupId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { Stop-WithError "invalid backup id" }
  $headers = @{ Authorization = "Bearer $token" }
  $body = @{ backupId = $BackupId } | ConvertTo-Json -Compress
  Write-Note "creating backup '$BackupId' (content media is not included)"
  Invoke-RestMethod -Method Post -Uri "$(Get-SetupUrl $values)/api/admin/backups" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Compress
  $token = $null
  Write-Note "backup bundle is under NEBULA_BACKUP_PATH; back up content separately"
}

if ($Command -eq "help") { Show-Usage; exit 0 }
if ($TailscaleFqdn -and -not (Test-ExactTailscaleFqdn $TailscaleFqdn)) {
  Stop-WithError "-TailscaleFqdn must be one exact *.ts.net hostname"
}
Test-Prerequisites

switch ($Command) {
  "init" { Initialize-Deployment; [void](Test-Deployment); if ($Tailscale) { Write-Note "start Nebula, then authenticate Tailscale from owner Settings / Remote Access" } }
  "install" { Initialize-Deployment; $values = Test-Deployment; Start-Deployment $values }
  "validate" { [void](Test-Deployment) }
  { $_ -in @("up", "start") } { $values = Test-Deployment; Start-Deployment $values }
  { $_ -in @("down", "stop") } { [void](Get-DeploymentEnvironment); Invoke-Compose @("down") }
  "status" { [void](Get-DeploymentEnvironment); Invoke-Compose @("ps") }
  "logs" {
    [void](Get-DeploymentEnvironment)
    $arguments = @("logs", "--tail", [string]$Tail)
    if ($Follow) { $arguments += "-f" }
    Invoke-Compose ($arguments + @("dashboard", "tailscale"))
  }
  { $_ -in @("update", "upgrade") } {
    $values = Test-Deployment
    Write-Note "updating the checked-out revision only; create and verify a backup before migrations"
    Invoke-Compose @("build", "--pull")
    Invoke-Compose @("up", "-d")
    Wait-ForReadiness $values
    Write-Note "updated server URL: $(Get-SetupUrl $values)"
  }
  "backup" { New-OnlineBackup }
}
