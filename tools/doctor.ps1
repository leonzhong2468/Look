# ============================================================
#  Look · 环境检测与一键修复
#  作者：Leon
#  用法：
#    doctor.ps1            交互菜单（检测 + 修复）
#    doctor.ps1 -Check     只检测
#    doctor.ps1 -Fix       直接一键修复
#    doctor.ps1 -DeepFix   深度修复（会清掉登录态，需重新扫码）
# ============================================================
param(
  [switch]$Check,
  [switch]$Fix,
  [switch]$DeepFix
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot
if (-not $ROOT) { $ROOT = (Get-Location).Path }
$UD = Join-Path $ROOT 'userdata'
$APP = Join-Path $ROOT 'resources\app'
$EXE = Get-ChildItem -Path $ROOT -Filter '*.exe' -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -notlike '*unins*' -and $_.Name -notlike '*rcedit*' } | Select-Object -First 1
$PROCNAME = if ($EXE) { [System.IO.Path]::GetFileNameWithoutExtension($EXE.Name) } else { 'Look' }

$script:pass = 0
$script:warn = 0
$script:fail = 0

function Line { param([string]$c = '-') Write-Host ($c * 62) -ForegroundColor DarkGray }
function Head { param([string]$t) Write-Host ''; Write-Host " $t" -ForegroundColor Cyan; Line }
function OK   { param([string]$t, [string]$d = '') $script:pass++; Write-Host "  [OK]   $t" -ForegroundColor Green; if ($d) { Write-Host "         $d" -ForegroundColor DarkGray } }
function WARN { param([string]$t, [string]$d = '') $script:warn++; Write-Host "  [!!]   $t" -ForegroundColor Yellow; if ($d) { Write-Host "         $d" -ForegroundColor DarkGray } }
function BAD  { param([string]$t, [string]$d = '') $script:fail++; Write-Host "  [XX]   $t" -ForegroundColor Red; if ($d) { Write-Host "         $d" -ForegroundColor DarkGray } }
function Info { param([string]$t) Write-Host "         $t" -ForegroundColor DarkGray }

function Banner {
  Clear-Host
  Write-Host ''
  Write-Host '  Look  v1.0' -ForegroundColor White
  Write-Host '  环境检测与一键修复工具   v1.0   by Leon' -ForegroundColor DarkGray
  Line '='
  Write-Host "  程序目录： $ROOT" -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------- 检测项 ----------------
function Test-System {
  Head '1 / 8  系统环境'
  $v = [System.Environment]::OSVersion.Version
  if ($v.Major -ge 10) { OK "Windows $($v.Major).$($v.Minor)（$([System.Environment]::OSVersion.VersionString)）" }
  else { WARN "Windows 版本偏低（$($v.Major).$($v.Minor)）" '建议 Windows 10 1809 及以上，老系统可能缺 dll' }

  $is64 = [Environment]::Is64BitOperatingSystem
  if ($is64) { OK '64 位系统' } else { BAD '32 位系统不支持' '本程序只有 x64 版本' }

  try {
    $free = [math]::Round((Get-PSDrive -Name ($ROOT.Substring(0,1)) -ErrorAction Stop).Free / 1GB, 1)
    if ($free -ge 5) { OK "磁盘剩余 $free GB" }
    elseif ($free -ge 1) { WARN "磁盘剩余 $free GB 偏少" '生成视频会占用空间，建议留 5 GB 以上' }
    else { BAD "磁盘剩余 $free GB" '空间不足，下载成品会失败' }
  } catch { Info '读取磁盘空间失败（不影响使用）' }
}

function Test-Files {
  Head '2 / 8  运行时文件完整性'
  if (-not $EXE) { BAD '找不到主程序 exe' '请确认解压完整，或重新解压一次' }
  else { OK "主程序：$($EXE.Name)（$([math]::Round($EXE.Length/1MB,1)) MB）" }

  $need = @(
    'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll',
    'd3dcompiler_47.dll', 'snapshot_blob.bin', 'v8_context_snapshot.bin'
  )
  $miss = @()
  foreach ($f in $need) { if (-not (Test-Path (Join-Path $ROOT $f))) { $miss += $f } }
  if ($miss.Count -eq 0) { OK "Electron 运行时文件齐全（$($need.Count) 个）" }
  else { BAD "缺少 $($miss.Count) 个运行时文件" (($miss -join '、') + '  ← 重新解压可修复') }

  $missApp = @()
  foreach ($f in @('main.js','preload.js','index.html','style.css','renderer.js','task-ui.js','package.json','lib\ext.js','lib\pipeline.js','lib\prompt.js','lib\formats.js','lib\craft.js','lib\providers.js','lib\driver.js')) {
    if (-not (Test-Path (Join-Path $APP $f))) { $missApp += $f }
  }
  if ($missApp.Count -eq 0) { OK '程序源码齐全（resources\app）' }
  else { BAD "源码缺少 $($missApp.Count) 个文件" (($missApp -join '、') + '  ← 重新解压可修复') }

  $lic = Test-Path (Join-Path $ROOT 'LICENSES.chromium.html')
  if (-not $lic) { WARN 'LICENSES.chromium.html 缺失' '不影响运行，但请保留许可文件' }
}

function Test-Writable {
  Head '3 / 8  目录写入权限'
  $probe = Join-Path $ROOT ('.wtest_' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.tmp')
  try {
    'ok' | Out-File -FilePath $probe -Encoding ascii -ErrorAction Stop
    Remove-Item $probe -Force -ErrorAction SilentlyContinue
    OK '程序目录可写（能存配置、下载成品）'
  } catch {
    BAD '程序目录不可写' '可能放在 C:\Program Files 或只读盘 → 换到 D:\ 这类普通目录'
  }
  if (Test-Path $UD) {
    $p2 = Join-Path $UD ('.wtest.tmp')
    try { 'ok' | Out-File -FilePath $p2 -Encoding ascii -ErrorAction Stop; Remove-Item $p2 -Force -ErrorAction SilentlyContinue; OK 'userdata 可写' }
    catch { BAD 'userdata 不可写' '账号与配置存不进去 → 检查是否被占用或只读' }
  }
}

function Test-Process {
  Head '4 / 8  进程状态'
  $procs = Get-Process -Name $PROCNAME -ErrorAction SilentlyContinue
  $n = @($procs).Count
  if ($n -eq 0) { OK '没有残留进程' }
  elseif ($n -le 1) { WARN "程序正在运行（$n 个进程）" '要修复请先在托盘右键退出，或选「一键修复」自动结束' }
  else { WARN "有 $n 个进程在跑（可能上次没退干净）" '选「一键修复」会自动结束残留进程' }

  $bad = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $PROCNAME -and $_.Id -ne $PID }
  if ($bad) { Info ("相关进程：" + (($bad | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ', ')) }
}

function Test-Tcp {
  param([string]$Target, [int]$Port = 443, [int]$TimeoutMs = 4000)
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($Target, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $c.EndConnect($iar)
    return $true
  } catch { return $false } finally { try { $c.Close() } catch {} }
}

function Test-Net {
  Head '5 / 8  网络连通性'
  foreach ($h in @('www.doubao.com', 'lf-flow-web-cdn.doubao.com')) {
    if (Test-Tcp -Target $h -Port 443) { OK "能连通 $h`:443" }
    else { WARN "连不上 $h`:443" '代理 / 防火墙 / DNS 问题。程序需要访问豆包才能生成' }
  }
  $proxy = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue)
  if ($proxy -and $proxy.ProxyEnable -eq 1) { Info "检测到系统代理：$($proxy.ProxyServer)（如果页面打不开，试着关掉代理）" }
}

function Test-Data {
  Head '6 / 8  数据完整性（账号 / 任务 / 配置）'
  if (-not (Test-Path $UD)) { WARN '还没有 userdata 目录' '第一次运行会自动创建'; return }
  OK 'userdata 存在'

  foreach ($j in @('accounts.json', 'prefs.json', 'config.json', 'providers.json', 'tasks.json')) {
    $p = Join-Path $UD $j
    if (-not (Test-Path $p)) { continue }
    try {
      $raw = Get-Content -Path $p -Raw -Encoding UTF8 -ErrorAction Stop
      if ([string]::IsNullOrWhiteSpace($raw)) { WARN "$j 是空文件" '可以删掉，程序会重建'; continue }
      $null = $raw | ConvertFrom-Json
    } catch {
      BAD "$j 内容已损坏（JSON 解析失败）" '选「一键修复」会把它备份成 .bad 并重建'
    }
  }
  if (Test-Path (Join-Path $UD 'accounts.json')) {
    try {
      $acc = Get-Content (Join-Path $UD 'accounts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      $c = @($acc).Count
      if ($c -gt 0) { OK "已保存 $c 个账号" } else { Info '还没有账号（第一次用要先扫码加号）' }
    } catch {}
  }
  $parts = Join-Path $UD 'Partitions'
  if (Test-Path $parts) {
    $pc = @(Get-ChildItem $parts -Directory -ErrorAction SilentlyContinue).Count
    OK "浏览器分区 $pc 个（每个账号一个，里面是登录态）"
  }
  $dl = Join-Path $ROOT 'downloads'
  if (Test-Path $dl) {
    $sz = 0
    try { $sz = [math]::Round(((Get-ChildItem $dl -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 1) } catch {}
    Info "downloads 已占用 $sz MB"
  }
  $log = Join-Path $ROOT 'app-run.log'
  if (Test-Path $log) {
    $sz = [math]::Round((Get-Item $log).Length / 1KB, 1)
    OK "日志存在（$sz KB）"
    Write-Host '         —— 日志最后 6 行 ——' -ForegroundColor DarkGray
    try { Get-Content $log -Tail 6 -Encoding UTF8 | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray } } catch {}
  } else {
    Info '还没有日志（程序还没成功启动过）'
  }
}

function Test-Cache {
  Head '7 / 8  缓存健康度'
  $caches = @('GPUCache', 'Cache', 'Code Cache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'ShaderCache', 'GrShaderCache')
  $bad = @()
  foreach ($c in $caches) {
    $p = Join-Path $UD $c
    if (Test-Path $p) {
      $files = @(Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue)
      if ($files.Count -gt 0 -and ($files | Measure-Object Length -Sum).Sum -eq 0) { $bad += $c }
    }
  }
  if ($bad.Count -eq 0) { OK '缓存没有明显异常' }
  else { WARN "$($bad.Count) 个缓存目录内容为 0（可能已损坏）" (($bad -join '、') + '  ← 一键修复会清理') }

  $crash = Join-Path $UD 'crashes'
  if (Test-Path $crash) {
    $dmp = @(Get-ChildItem $crash -Filter '*.dmp' -ErrorAction SilentlyContinue)
    if ($dmp.Count -gt 0) { WARN "发现 $($dmp.Count) 个崩溃转储" '最近崩过；把 app-run.log 发给作者看' }
  }
  $old = @(Get-ChildItem $UD -Directory -Filter 'old_*' -ErrorAction SilentlyContinue)
  if ($old.Count -gt 0) { Info "有 $($old.Count) 个 old_* 残留目录（无害，一键修复会顺手清）" }
}

function Test-Security {
  Head '8 / 8  安全软件干扰提示'
  $def = $null
  try { $def = Get-MpComputerStatus -ErrorAction Stop } catch {}
  if ($def) {
    if ($def.RealTimeProtectionEnabled) { Info 'Windows Defender 实时保护：开启（若 exe 莫名消失/变慢，把整个文件夹加白名单）' }
    else { OK 'Windows Defender 实时保护：关闭' }
  } else { Info '未检测到 Defender（第三方杀软同理：建议把程序目录加入白名单）' }
  Info '提示：从压缩包直接双击运行容易出问题，务必先完整解压'
}

# ---------------- 修复 ----------------
function Kill-Residual {
  $p = Get-Process -Name $PROCNAME -ErrorAction SilentlyContinue
  if ($p) {
    $p | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
    Start-Sleep -Milliseconds 800
    $p = Get-Process -Name $PROCNAME -ErrorAction SilentlyContinue
    if ($p) { $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
    Write-Host '  · 已结束残留进程' -ForegroundColor Yellow
  }
}

function Clear-AllCache {
  $names = @('GPUCache', 'Cache', 'Code Cache', 'DawnWebGPUCache', 'DawnGraphiteCache',
             'ShaderCache', 'GrShaderCache', 'GPUCacheCache', 'blob_storage', 'Session Storage')
  $n = 0
  foreach ($c in $names) {
    $p = Join-Path $UD $c
    if (Test-Path $p) {
      try { Remove-Item $p -Recurse -Force -ErrorAction Stop; $n++ } catch {}
    }
  }
  Get-ChildItem $UD -Directory -Filter 'old_*' -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch {}
  }
  Get-ChildItem $UD -Filter '*.tmp' -File -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {}
  }
  Write-Host "  · 已清理 $n 个缓存目录" -ForegroundColor Yellow
}

function Fix-Json {
  $files = @('prefs.json', 'config.json', 'providers.json', 'tasks.json', 'accounts.json')
  foreach ($f in $files) {
    $p = Join-Path $UD $f
    if (-not (Test-Path $p)) { continue }
    $bad = $false
    try {
      $raw = Get-Content $p -Raw -Encoding UTF8
      if ([string]::IsNullOrWhiteSpace($raw)) { $bad = $true }
      else { $null = $raw | ConvertFrom-Json }
    } catch { $bad = $true }
    if ($bad) {
      $bak = "$p.bad-" + (Get-Date -Format 'yyyyMMddHHmmss')
      try { Move-Item $p $bak -Force; Write-Host "  · 修复损坏的 $f（已备份为 $(Split-Path $bak -Leaf)）" -ForegroundColor Yellow } catch {}
    }
  }
}

function Rotate-Log {
  $log = Join-Path $ROOT 'app-run.log'
  if (Test-Path $log) {
    if ((Get-Item $log).Length -gt 512KB) {
      try {
        $bak = Join-Path $ROOT ('app-run.old-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.log')
        Move-Item $log $bak -Force
        Write-Host '  · 日志已归档（太大影响排查）' -ForegroundColor Yellow
      } catch {}
    }
  }
}

function Clear-Partitions {
  $parts = Join-Path $UD 'Partitions'
  if (-not (Test-Path $parts)) { Write-Host '  · 没有分区目录，跳过' -ForegroundColor DarkGray; return }
  $n = 0
  Get-ChildItem $parts -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch {}
  }
  Write-Host "  · 已清空 $n 个账号分区（登录态已重置，需要重新扫码）" -ForegroundColor Yellow
}

function Do-Fix {
  param([switch]$Deep)
  Banner
  Write-Host '  正在一键修复…' -ForegroundColor Cyan
  Line
  Kill-Residual
  Clear-AllCache
  Fix-Json
  Rotate-Log
  if ($Deep) {
    Write-Host ''
    Write-Host '  ⚠ 深度修复会清掉所有账号的登录态（要重新扫码）。' -ForegroundColor Yellow
    Write-Host '  5 秒后开始，按 Ctrl+C 可取消…' -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    Clear-Partitions
  }
  Write-Host ''
  Line
  Write-Host '  修复完成。' -ForegroundColor Green
  Write-Host '  现在重新启动程序试试。' -ForegroundColor Green
  Line
  Ask-Start
}

function Ask-Start {
  Write-Host ''
  $a = Read-Host '  现在启动程序吗？(Y/n)'
  if ($a -eq '' -or $a -match '^[Yy]') {
    if ($EXE) { try { Start-Process -FilePath $EXE.FullName -WorkingDirectory $ROOT; Write-Host '  已启动。' -ForegroundColor Green } catch { Write-Host "  启动失败：$($_.Exception.Message)" -ForegroundColor Red } }
    else { Write-Host '  找不到主程序 exe。' -ForegroundColor Red }
  }
}

# ---------------- 主流程 ----------------
function Do-Check {
  Banner
  Test-System
  Test-Files
  Test-Writable
  Test-Process
  Test-Net
  Test-Data
  Test-Cache
  Test-Security
  Write-Host ''
  Line '='
  Write-Host ("  检测结果： 通过 {0}   提醒 {1}   异常 {2}" -f $script:pass, $script:warn, $script:fail) -ForegroundColor White
  if ($script:fail -eq 0 -and $script:warn -eq 0) { Write-Host '  环境很干净，没有发现问题。' -ForegroundColor Green }
  elseif ($script:fail -eq 0) { Write-Host '  没有致命问题，黄色的提醒可以按需处理。' -ForegroundColor Yellow }
  else { Write-Host '  有红色异常，建议先跑「一键修复」，还不行就重新解压。' -ForegroundColor Red }
  Line '='
}

if ($Check) { Do-Check; exit 0 }
if ($Fix) { Do-Fix; exit 0 }
if ($DeepFix) { Do-Fix -Deep; exit 0 }

# 交互菜单
while ($true) {
  Banner
  Write-Host '  [1] 开始检测（只检查，不改任何东西）' -ForegroundColor White
  Write-Host '  [2] 一键修复（结束残留进程 + 清缓存 + 修损坏配置）' -ForegroundColor White
  Write-Host '  [3] 深度修复（上面全部 + 清账号登录态，需重新扫码）' -ForegroundColor White
  Write-Host '  [4] 打开程序目录' -ForegroundColor White
  Write-Host '  [5] 查看日志最后 40 行' -ForegroundColor White
  Write-Host '  [0] 退出' -ForegroundColor DarkGray
  Write-Host ''
  $c = Read-Host '  请输入序号'
  switch ($c) {
    '1' { Do-Check; Write-Host ''; Read-Host '  按回车返回菜单' | Out-Null }
    '2' { Do-Fix; Write-Host ''; Read-Host '  按回车返回菜单' | Out-Null }
    '3' { Do-Fix -Deep; Write-Host ''; Read-Host '  按回车返回菜单' | Out-Null }
    '4' { Start-Process explorer.exe $ROOT }
    '5' {
      $log = Join-Path $ROOT 'app-run.log'
      Banner
      if (Test-Path $log) {
        Write-Host '  最后 40 行日志：' -ForegroundColor Cyan
        Line
        Get-Content $log -Tail 40 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
      } else { Write-Host '  还没有日志文件（程序没成功启动过）。' -ForegroundColor Yellow }
      Write-Host ''
      Read-Host '  按回车返回菜单' | Out-Null
    }
    '0' { exit 0 }
    default { }
  }
}
