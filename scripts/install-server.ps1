# Installs the Nanovia server plugin into a SillyTavern folder (Windows).
# Usage: .\scripts\install-server.ps1 -SillyTavern "C:\path\to\SillyTavern"
# Then set enableServerPlugins: true in config.yaml and restart SillyTavern.
param(
    [Parameter(Mandatory = $true)][string]$SillyTavern
)

$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
$plugins = Join-Path $SillyTavern 'plugins'
if (-not (Test-Path (Join-Path $SillyTavern 'server.js')) -and -not (Test-Path $plugins)) {
    throw "Not a SillyTavern folder (no server.js and no plugins\): $SillyTavern"
}
if (-not (Test-Path (Join-Path $source 'index.js'))) {
    throw "server\index.js is missing: run 'npm run build:server' first"
}
$target = Join-Path $plugins 'nanovia'
if (Test-Path (Join-Path $target '.git')) {
    throw "$target is a git checkout; update it with git instead."
}
New-Item -ItemType Directory -Force $target | Out-Null
# Keep the installed config.json (port, upstream) and data\ (usage log); copy only the two files the plugin needs.
Get-ChildItem -Path $target -Exclude 'config.json', 'data' | Remove-Item -Recurse -Force -Confirm:$false
foreach ($file in 'index.js', 'package.json') {
    Copy-Item -Path (Join-Path $source $file) -Destination $target -Force
}

Write-Output "Nanovia plugin installed to $target"
$configYaml = Join-Path $SillyTavern 'config.yaml'
if ((Test-Path $configYaml) -and -not (Select-String -Path $configYaml -Pattern '^enableServerPlugins:\s*true' -Quiet)) {
    Write-Output "Set 'enableServerPlugins: true' in $configYaml (or env SILLYTAVERN_ENABLESERVERPLUGINS=true), then restart SillyTavern."
} else {
    Write-Output 'Restart SillyTavern to load the plugin.'
}
Write-Output 'The proxy port (default 8787) is local to the machine or container; do not publish it.'
