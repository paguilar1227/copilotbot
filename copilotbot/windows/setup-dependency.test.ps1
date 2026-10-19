param([string]$SetupScript = (Join-Path $PSScriptRoot 'setup-dependency.ps1'))
$ErrorActionPreference = 'Stop'
$powershell = (Get-Command powershell.exe).Source
$fixture = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path "$fixture\System32" -Force | Out-Null
# Reproduce Windows PowerShell 5.1's terminating NativeCommandError when
# a missing WSL reports its status on stderr. Never touch the host's WSL.
Add-Type -TypeDefinition 'public class FakeWsl { public static int Main() { System.Console.Error.WriteLine("WSL is not installed"); return 1; } }' -OutputAssembly "$fixture\System32\wsl.exe" -OutputType ConsoleApplication
$harness = Join-Path $fixture 'harness.ps1'
@'
param($SetupScript, $Fixture, [int]$StatusCode, $Trace)
$ErrorActionPreference = 'Stop'
$env:WINDIR = $Fixture
function global:Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle)
  @{ arguments=@($ArgumentList); verb=$Verb } | ConvertTo-Json -Compress | Add-Content $Trace
  if ($ArgumentList -contains '--status') { return [pscustomobject]@{ ExitCode=$StatusCode } }
  return [pscustomobject]@{ ExitCode=0 }
}
& $SetupScript -Dependency wsl
'@ | Set-Content $harness
foreach ($case in @(@{status=1; action='--install'}, @{status=0; action='--update'})) {
  $trace = Join-Path $fixture ("trace-$($case.status).jsonl")
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $harness $SetupScript $fixture $case.status $trace
  if ($LASTEXITCODE -ne 0) { throw "WSL setup failed before it could request $($case.action)." }
  $calls = @(Get-Content $trace | ForEach-Object { $_ | ConvertFrom-Json })
  if ($calls.Count -ne 2 -or $calls[0].arguments -notcontains '--status') { throw 'Expected a status probe and a setup request.' }
  if ($calls[1].arguments -notcontains $case.action -or $calls[1].verb -ne 'RunAs') { throw "Expected elevated $($case.action)." }
}
Write-Output 'WSL missing and installed status regression checks passed under Windows PowerShell.'
