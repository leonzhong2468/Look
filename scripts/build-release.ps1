# ============================================================
#  Look · 一键打发布包
#  作者：Leon
#
#  作用：把「Electron 运行时 + src 源码 + 文档 + 工具」组装成一个
#        可直接分发的绿色版目录，并打包成 zip。
#
#  前置条件：
#    1. 本机已装 Node.js（用来下载 Electron 运行时）
#    2. 仓库同级有 electron 运行时目录，或用 -ElectronDir 指定
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#    powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -ElectronDir "D:\electron-v43-win32-x64"
# ============================================================
param(
  [string]$ElectronDir = "",
  [string]$OutDir = "",
  [string]$Version = "1.0.0",
  [string]$AppName = "Look"
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $Repo) 'release' }

function Say($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Die($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  打包：' -NoNewline
Write-Host $AppName -ForegroundColor White
Write-Host "  版本：$Version" -ForegroundColor DarkGray
Write-Host "  输出：$OutDir" -ForegroundColor DarkGray
Write-Host ''

# ---------- 1. 找 Electron 运行时 ----------
if (-not $ElectronDir) {
  $cands = @(
    (Join-Path $Repo 'electron'),
    (Join-Path (Split-Path -Parent $Repo) 'electron'),
    (Join-Path $env:LOCALAPPDATA 'electron\Cache')
  )
  foreach ($c in $cands) {
    if (Test-Path (Join-Path $c 'electron.exe')) { $ElectronDir = $c; break }
  }
}
if (-not $ElectronDir -or -not (Test-Path (Join-Path $ElectronDir 'electron.exe'))) {
  Die "没找到 Electron 运行时。请用 -ElectronDir 指定一个已解压的 electron-vXX-win32-x64 目录。`n      （下载：https://github.com/electron/electron/releases）"
}
Say "Electron 运行时：$ElectronDir"

# ---------- 2. 准备输出目录 ----------
$Stage = Join-Path $OutDir "stage-$Version"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

Say '复制 Electron 运行时…'
Copy-Item (Join-Path $ElectronDir '*') $Stage -Recurse -Force
# 去掉开发用的东西
foreach ($f in @('electron.exe', 'resources\default_app.asar')) {
  $p = Join-Path $Stage $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

Say '复制源码…'
$AppDir = Join-Path $Stage 'resources\app'
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
New-Item -ItemType Directory -Path $AppDir | Out-Null
Copy-Item (Join-Path $Repo 'src\*') $AppDir -Recurse -Force
# 别把开发依赖带出去
$nm = Join-Path $AppDir 'node_modules'
if (Test-Path $nm) { Remove-Item $nm -Recurse -Force }
Remove-Item (Join-Path $AppDir 'package-lock.json') -Force -ErrorAction SilentlyContinue

Say '复制文档与工具…'
$docSrc = Join-Path $AppDir 'docs'
$docDst = Join-Path $Stage '文档'
New-Item -ItemType Directory -Path $docDst -Force | Out-Null
Get-ChildItem $docSrc -Filter '*.md' | Copy-Item -Destination $docDst -Force
Copy-Item (Join-Path $Repo '免责声明.md') $docDst -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $Stage 'tools') -Force | Out-Null

# doctor.ps1 在发布包里，仓库里可能没有，找一下
$doctor = Get-ChildItem -Path $Repo -Filter 'doctor.ps1' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($doctor) { Copy-Item $doctor.FullName (Join-Path $Stage 'tools\doctor.ps1') -Force; Ok '已放入环境检测脚本' }
else { Write-Host '  [!] 没找到 doctor.ps1，跳过环境检测工具' -ForegroundColor Yellow }

# 根目录的 bat（启动备用 / 环境检测入口），有就一起带走
Get-ChildItem -Path $Repo -Filter '*.bat' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*一键安装*' } |
  ForEach-Object { Copy-Item $_.FullName $Stage -Force; Ok "已放入启动脚本：$($_.Name)" }

# ---------- 3. 重命名 exe + 写图标版本 ----------
$targetExe = Join-Path $Stage ($AppName + '.exe')
if (-not (Test-Path (Join-Path $Stage 'electron.exe'))) {
  # 有些运行时叫 electron.exe 已被上面删掉，用备份方式：从 -ElectronDir 再拿一份
  Copy-Item (Join-Path $ElectronDir 'electron.exe') $targetExe -Force
} else {
  Move-Item (Join-Path $Stage 'electron.exe') $targetExe -Force
}
Ok "主程序：$AppName.exe"

$rcedit = Join-Path $Repo 'rcedit-x64.exe'
if (Test-Path $rcedit) {
  Say '写入图标与版本信息…'
  $ico = Join-Path $Repo 'src\app.ico'
  & $rcedit $targetExe `
    --set-icon $ico `
    --set-file-version "$Version.0" `
    --set-product-version "$Version.0" `
    --set-version-string 'CompanyName' 'Leon' `
    --set-version-string 'ProductName' $AppName `
    --set-version-string 'FileDescription' 'Look' `
    --set-version-string 'LegalCopyright' 'Copyright (C) 2026 Leon - MIT License' `
    --set-version-string 'OriginalFilename' ($AppName + '.exe') `
    --set-version-string 'InternalName' 'Look'
  Ok '已写入'
} else {
  Write-Host '  [!] 没有 rcedit-x64.exe，跳过图标与版本信息' -ForegroundColor Yellow
}

# ---------- 4. 打 zip ----------
$zip = Join-Path $OutDir ("{0}-v{1}.zip" -f $AppName, $Version)
if (Test-Path $zip) { Remove-Item $zip -Force }
Say '压缩…'
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Ok "完成：$zip （$mb MB）"

Write-Host ''
Write-Host '  下一步：' -ForegroundColor White
Write-Host "    1. 到 GitHub → Releases → Draft a new release" -ForegroundColor Gray
Write-Host "    2. Tag: v$Version" -ForegroundColor Gray
Write-Host "    3. 上传 $([System.IO.Path]::GetFileName($zip))" -ForegroundColor Gray
Write-Host '    4. 写清楚这一版改了什么' -ForegroundColor Gray
Write-Host ''
