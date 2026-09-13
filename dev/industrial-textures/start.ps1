$ErrorActionPreference = 'Stop'
$previewRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $previewRoot
$env:SKYNET_PORT = '18792'
$env:SKYNET_DEFAULT_MODEL = 'openai/gpt-4o-mini'
node dev/industrial-textures/seed-preview.cjs
Write-Host 'Open http://127.0.0.1:18792/?textures=industrial'
node dev/seed.js --keep
