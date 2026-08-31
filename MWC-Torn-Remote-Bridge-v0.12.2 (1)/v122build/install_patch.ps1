$ErrorActionPreference = "Stop"
$projectPath = Read-Host 'Enter the full path to your Mor-War-Coordinator project folder'
$projectPath = $projectPath.Trim('"')
if (-not (Test-Path (Join-Path $projectPath 'bot.py'))) { throw "bot.py was not found in: $projectPath" }
if (-not (Test-Path (Join-Path $projectPath 'services\userscript_api.py'))) { throw "services\userscript_api.py was not found. Install v0.11+ first." }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $projectPath "z.PatchBackups\userscript-return-v0.12.2-$stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $backup 'services') | Out-Null
Copy-Item (Join-Path $projectPath 'services\userscript_api.py') (Join-Path $backup 'services\userscript_api.py') -Force
Write-Host "Backing up current API to: $backup"
Write-Host 'Installing SKIP/RETURN coordinator control...'
Copy-Item (Join-Path $PSScriptRoot 'patch_files\services\userscript_api.py') (Join-Path $projectPath 'services\userscript_api.py') -Force
Push-Location $projectPath
try {
    Write-Host 'Checking Python syntax...'
    python -m py_compile services\userscript_api.py
    if ($LASTEXITCODE -ne 0) { throw 'Python syntax check failed.' }
}
finally { Pop-Location }
Write-Host ''
Write-Host 'v0.12.2 backend patch installed successfully.'
Write-Host 'Restart the bot, then replace Tampermonkey with faction-war-coordinator.user.js.'
