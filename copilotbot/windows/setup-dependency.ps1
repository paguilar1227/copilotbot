param([ValidateSet('docker', 'wsl', 'desktop')][string]$Dependency)
$ErrorActionPreference = 'Stop'
if ($Dependency -eq 'desktop') {
  $candidates = @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'), (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))
  $desktop = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $desktop) { throw 'Docker Desktop was not found.' }
  Start-Process -FilePath $desktop
  exit 0
}
if ($Dependency -eq 'wsl') {
  # On Windows PowerShell 5.1, redirecting a native program's stderr can
  # terminate the script before LASTEXITCODE is checked. Missing WSL is an
  # expected status, so inspect the process exit code without that redirection.
  $status = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" -ArgumentList '--status' -WindowStyle Hidden -Wait -PassThru
  $arguments = if ($status.ExitCode -eq 0) { @('--update') } else { @('--install', '--no-distribution') }
  $process = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "WSL installation returned $($process.ExitCode)." }
  exit $process.ExitCode
}
$directory = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $directory | Out-Null
$installer = Join-Path $directory 'Docker Desktop Installer.exe'
Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Docker Inc') {
  throw 'The Docker installer signature could not be verified.'
}
# Keep the vendor UI visible so the owner can review its license and installation options.
$process = Start-Process -FilePath $installer -ArgumentList 'install','--user','--backend=wsl-2' -Wait -PassThru
if ($process.ExitCode -notin @(0, 3010)) { throw "Docker installation returned $($process.ExitCode)." }
exit $process.ExitCode
