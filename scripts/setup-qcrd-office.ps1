# ════════════════════════════════════════════════════════════
#  setup-qcrd-office.ps1 — เปิดใช้ QC/RD บน SQL จากเครื่องออฟฟิศ (ทำครั้งเดียว)
#
#  ใช้เมื่อ SQL Server ไม่ได้เปิดพอร์ตออกเน็ต (ซึ่งถูกต้องแล้วในแง่ความปลอดภัย)
#  จึงให้ "เครื่องนี้" เป็นตัวกลาง: Dashboard บน Vercel -> api.khanoykorshabu.com -> SQL Server
#
#  วิธีใช้ — เปิด PowerShell (Run as Administrator ไม่ต้องก็ได้) แล้วรัน:
#     powershell -ExecutionPolicy Bypass -File .\scripts\setup-qcrd-office.ps1
#
#  สคริปต์จะ:
#     1) หาโฟลเดอร์ที่รัน API อยู่ (ตัวที่ตอบ http://localhost:14365/ping)
#     2) อัปเดตไฟล์ QC/RD ลงไป — git pull ถ้าเป็นรีโป, ไม่งั้นโหลดไฟล์จาก GitHub
#     3) แทรก 2 บรรทัดใน server.js ให้เปิด endpoint /qcrd/* (สำรองไฟล์เดิมไว้ก่อน)
#     4) ตั้ง QCRD_WRITE_KEY แล้วรีสตาร์ท API
#     5) ตรวจว่า /qcrd/ping ตอบแล้ว พร้อมบอกลิงก์ย้ายข้อมูลให้กดต่อ
#
#  ตัวเลือก
#     -ApiDir "D:\path\to\narai-api"   ระบุโฟลเดอร์เอง (ไม่ต้องให้หา)
#     -WriteKey "..."                  กำหนดกุญแจเอง (ไม่ใส่ = สุ่มให้)
#     -NoRestart                       อัปเดตไฟล์อย่างเดียว ไม่รีสตาร์ท API
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$ApiDir = '',
  [string]$WriteKey = '',
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$RAW = 'https://raw.githubusercontent.com/nookmagazineDev/naraipizzeria/main'
$PORT = 14365

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    ✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    ⚠️  $t" -ForegroundColor Yellow }

# ── 1) หาโฟลเดอร์ที่รัน API ─────────────────────────────────────────
Step 1 'หาโฟลเดอร์ที่รัน Narai API อยู่'
if (-not $ApiDir) {
  # ดูจาก command line ของ process node ที่รันอยู่ (ปกติคือ "node server.js")
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.CommandLine -match 'server\.js') {
      $cwd = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).Path
      # หา path ของ server.js จาก command line ก่อน ถ้าเป็น path เต็ม
      if ($p.CommandLine -match '([A-Za-z]:\\[^"]*?server\.js)') { $ApiDir = Split-Path -Parent $Matches[1]; break }
    }
  }
}
if (-not $ApiDir) {
  Warn 'หาจาก process ไม่เจอ — ไล่หาไฟล์ server.js ในไดรฟ์ C: และ D:'
  $found = Get-ChildItem C:\, D:\ -Filter server.js -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object -First 5
  if ($found) {
    Write-Host '    เจอไฟล์เหล่านี้:' -ForegroundColor DarkGray
    $found | ForEach-Object { Write-Host "      $($_.FullName)" }
    $ApiDir = Split-Path -Parent $found[0].FullName
  }
}
if (-not $ApiDir -or -not (Test-Path (Join-Path $ApiDir 'server.js'))) {
  throw "หาโฟลเดอร์ API ไม่เจอ — รันใหม่โดยระบุเอง เช่น -ApiDir 'D:\naraiสาขา\narai-api'"
}
Ok "ใช้โฟลเดอร์: $ApiDir"

# ── 2) อัปเดตไฟล์ QC/RD ───────────────────────────────────────────
Step 2 'อัปเดตไฟล์ QC/RD'
$isRepo = $false
try {
  $remote = & git -C $ApiDir remote get-url origin 2>$null
  if ($LASTEXITCODE -eq 0 -and $remote -match 'naraipizzeria') { $isRepo = $true }
} catch { }

if ($isRepo) {
  & git -C $ApiDir pull origin main
  if ($LASTEXITCODE -ne 0) { throw 'git pull ไม่สำเร็จ — แก้ conflict แล้วรันใหม่' }
  Ok 'git pull เรียบร้อย (โฟลเดอร์นี้เป็นรีโป)'
} else {
  # โฟลเดอร์ที่ก๊อปไฟล์มาวางเฉย ๆ — โหลดเฉพาะไฟล์ที่ต้องใช้จาก GitHub
  Warn 'ไม่ใช่รีโป — โหลดไฟล์ที่ต้องใช้จาก GitHub มาวางแทน'
  $files = @{
    'qcrd-db.js'       = "$RAW/host-server/qcrd-db.js"
    'qcrdSql.mjs'      = "$RAW/lib/qcrdSql.mjs"
    'qcrdMigrate.mjs'  = "$RAW/lib/qcrdMigrate.mjs"
    'schema-qcrd.sql'  = "$RAW/docs/schema-qcrd.sql"
  }
  foreach ($name in $files.Keys) {
    $dest = Join-Path $ApiDir $name
    Invoke-WebRequest -Uri $files[$name] -OutFile $dest -UseBasicParsing
    Ok "โหลด $name"
  }
}

# ── 3) แทรกโค้ดเปิด endpoint /qcrd/* ใน server.js ───────────────────
Step 3 'เปิด endpoint /qcrd/* ใน server.js'
$serverPath = Join-Path $ApiDir 'server.js'
$server = Get-Content $serverPath -Raw -Encoding UTF8
if ($server -match 'mountQcrd') {
  Ok 'server.js มีโค้ดส่วนนี้อยู่แล้ว ไม่ต้องแก้'
} else {
  $backup = "$serverPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $serverPath $backup
  Ok "สำรองไฟล์เดิมไว้ที่ $(Split-Path -Leaf $backup)"

  # แทรก require ต่อจากบรรทัด require ตัวสุดท้ายด้านบนของไฟล์
  $requireLine = "const { mountQcrd } = require('./qcrd-db'); // QC/RD บน InventoryNarai"
  $server = [regex]::Replace($server, "(?m)^(const .*require\('compression'\).*)$", "`$1`r`n$requireLine", 1)
  if ($server -notmatch 'mountQcrd') {
    # ไม่เจอบรรทัด compression ก็แทรกหลัง require ตัวแรกที่เจอ
    $server = [regex]::Replace($server, "(?m)^(const .*= require\(.*\).*)$", "`$1`r`n$requireLine", 1)
  }
  # เรียก mountQcrd ก่อน app.listen
  $server = [regex]::Replace($server, "(?m)^(app\.listen\()", "mountQcrd(app);`r`n`r`n`$1", 1)
  if ($server -notmatch 'mountQcrd\(app\)') { throw 'แทรกโค้ดไม่สำเร็จ — เปิด server.js แล้วเพิ่มเองสองบรรทัด (ดู README)' }
  Set-Content $serverPath $server -Encoding UTF8 -NoNewline
  Ok 'แทรก 2 บรรทัดเรียบร้อย'
}

# ── 4) ตั้งกุญแจ + รีสตาร์ท ────────────────────────────────────────
Step 4 'ตั้ง QCRD_WRITE_KEY แล้วรีสตาร์ท API'
if (-not $WriteKey) {
  if ($env:QCRD_WRITE_KEY) { $WriteKey = $env:QCRD_WRITE_KEY }
  else { $WriteKey = 'qcrd-' + [guid]::NewGuid().ToString('N').Substring(0, 20) }
}
$env:QCRD_WRITE_KEY = $WriteKey

# เก็บลงไฟล์ลับข้าง ๆ (ไม่ขึ้น git) เพื่อให้ครั้งหน้าเปิดมาก็ยังมีค่าเดิม
$envFile = Join-Path $ApiDir 'db.env.ps1'
$line = "`$env:QCRD_WRITE_KEY = '$WriteKey'"
if (Test-Path $envFile) {
  $cur = Get-Content $envFile -Raw -Encoding UTF8
  if ($cur -notmatch 'QCRD_WRITE_KEY') { Add-Content $envFile "`r`n# QC/RD (เพิ่มโดย setup-qcrd-office.ps1)`r`n$line" -Encoding UTF8 }
} else {
  Set-Content $envFile "# ค่าเชื่อมต่อของ Narai API (ไฟล์นี้ไม่ขึ้น git)`r`n$line" -Encoding UTF8
}
Ok "กุญแจ: $WriteKey  (เก็บไว้ใน db.env.ps1 แล้ว)"

if ($NoRestart) {
  Warn 'ข้ามการรีสตาร์ท (-NoRestart) — ต้องรีสตาร์ทเองถึงจะมีผล'
} else {
  $old = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.js' }
  foreach ($p in $old) {
    Write-Host "    ปิด node เดิม (PID $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $ApiDir -WindowStyle Normal
  Start-Sleep -Seconds 4
  Ok 'เริ่ม API ใหม่แล้ว'
}

# ── 5) ตรวจผล ─────────────────────────────────────────────────────
Step 5 'ตรวจว่า /qcrd/ping ตอบแล้ว'
try {
  $r = Invoke-RestMethod "http://localhost:$PORT/qcrd/ping" -TimeoutSec 20
  Ok "ต่อฐานได้: $($r.db) · เมนูใน SQL ตอนนี้ $($r.menus) · เขียนได้: $($r.writeEnabled)"
} catch {
  Warn "ยังเรียกไม่ได้: $($_.Exception.Message)"
  Warn "ดูหน้าต่าง node ที่เพิ่งเปิดว่ามี error อะไรขึ้นไหม"
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  พร้อมย้ายข้อมูลแล้ว — เปิดลิงก์นี้ในเบราว์เซอร์ทีละบรรทัด' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
$base = 'https://api.khanoykorshabu.com/qcrd/migrate'
@('check', 'schema&confirm=1', 'group&confirm=1', 'menu&confirm=1', 'bom&confirm=1', 'item&confirm=1', 'verify') |
  ForEach-Object { Write-Host "  $base`?key=$WriteKey&step=$_" }
Write-Host ''
Write-Host '  เสร็จแล้วไปตั้งบน Vercel (Settings > Environment Variables) แล้ว Redeploy:' -ForegroundColor White
Write-Host '     QCRD_SOURCE    = sql'
Write-Host "     QCRD_WRITE_KEY = $WriteKey"
Write-Host '     QCRD_API_BASE  = https://api.khanoykorshabu.com   (ตั้งเมื่อ STORE_API_BASE ชี้ที่อื่น)'
Write-Host ''
Write-Host '  รายละเอียด: docs/qcrd-sql-migration.md' -ForegroundColor DarkGray
