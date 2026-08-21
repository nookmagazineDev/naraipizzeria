# ════════════════════════════════════════════════════════════
#  migrate-sheets.ps1 — ย้าย แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน
#                       จาก Google Sheets ไป SQL Server
#  รันที่เครื่องออฟฟิศ (เครื่องที่ต่อ SQL Server ได้) จากโฟลเดอร์รีโป naraipizzeria
#
#  วิธีใช้ — เปิด PowerShell ที่โฟลเดอร์รีโป แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\migrate-sheets.ps1
#
#  ทำให้ครบทุกขั้นในรอบเดียว:
#     1) โหลดรหัสฐานข้อมูลจาก host-server\db.env.ps1 (ถ้ามี) แล้วเติมค่าที่ขาด
#     2) npm install (เฉพาะเมื่อยังไม่มี package mssql)
#     3) สร้างตาราง 5 ตารางจาก docs\schema-sheets.sql
#     4) สำรวจต้นทาง (--inspect) แล้วให้ยืนยันก่อนเขียนจริง
#     5) ย้ายข้อมูลจริง
#     6) เทียบจำนวนต้นทางกับ SQL (--verify)
#
#  ตัวเลือก
#     -Yes                   ไม่ต้องถามยืนยัน (ใช้ตอนรันซ้ำ/รันอัตโนมัติ)
#     -SkipSchema            ข้ามขั้นสร้างตาราง (เคยรันแล้ว)
#     -Only plan,expense     ย้ายเฉพาะบางชุด (plan,closing,expenseref,expense,employee)
#     -Db ชื่อฐาน             ฐานปลายทาง (ค่าเริ่มต้น InventoryNarai)
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$SkipSchema,
  [string]$Only = '',
  [string]$Db = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repo

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    ⚠️  $text" -ForegroundColor Yellow }

# ── 1) ค่าเชื่อมต่อฐานข้อมูล ─────────────────────────────────────────
Step 1 'ค่าเชื่อมต่อฐานข้อมูล'
$secret = Join-Path $repo 'host-server\db.env.ps1'
if (Test-Path $secret) { . $secret; Ok "โหลดค่าจาก host-server\db.env.ps1" }

# ตารางชุดนี้อยู่ฐานเดียวกับ QC/RD/สต๊อก บน SQLEXPRESS (คนละอินสแตนซ์กับ NaraiPos)
if (-not $env:QCRD_DB_SERVER)   { $env:QCRD_DB_SERVER = if ($env:DB_SERVER -and $env:DB_SERVER -match '\\') { $env:DB_SERVER } else { 'localhost\SQLEXPRESS' } }
if (-not $env:QCRD_DB_NAME)     { $env:QCRD_DB_NAME = if ($Db) { $Db } else { 'InventoryNarai' } }
if ($Db)                        { $env:QCRD_DB_NAME = $Db }
if (-not $env:QCRD_DB_USER)     { $env:QCRD_DB_USER = if ($env:DB_USER) { $env:DB_USER } else { 'sa' } }
if (-not $env:QCRD_DB_PASSWORD) { $env:QCRD_DB_PASSWORD = $env:DB_PASSWORD }
if (-not $env:QCRD_DB_PASSWORD) {
  $sec = Read-Host "รหัสผ่านของ $($env:QCRD_DB_USER) บน $($env:QCRD_DB_SERVER)" -AsSecureString
  $env:QCRD_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
Ok "ปลายทาง: $($env:QCRD_DB_SERVER)/$($env:QCRD_DB_NAME)  (user: $($env:QCRD_DB_USER))"

# ── 2) package ที่สคริปต์ใช้ ─────────────────────────────────────────
Step 2 'ตรวจ package mssql'
if (-not (Test-Path (Join-Path $repo 'node_modules\mssql'))) {
  Write-Host '    กำลัง npm install (ครั้งแรกใช้เวลาสักครู่)...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install ไม่สำเร็จ' }
}
Ok 'มี mssql พร้อมใช้งาน'

# ── 3) สร้างตาราง ───────────────────────────────────────────────────
if (-not $SkipSchema) {
  Step 3 'สร้างตาราง 5 ตาราง จาก docs\schema-sheets.sql'
  $sqlcmd = (Get-Command sqlcmd -ErrorAction SilentlyContinue).Source
  if ($sqlcmd) {
    & $sqlcmd -S $env:QCRD_DB_SERVER -U $env:QCRD_DB_USER -P $env:QCRD_DB_PASSWORD -i 'docs\schema-sheets.sql'
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาด้วย sqlcmd ไม่สำเร็จ' }
  } else {
    Warn 'ไม่พบ sqlcmd — ใช้ตัวรันของ node แทน (ผลเหมือนกัน)'
    node scripts\run-sql.mjs docs\schema-sheets.sql
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาไม่สำเร็จ' }
  }
  Ok 'ตารางพร้อมแล้ว (รันซ้ำได้ ไม่ทับของเดิม)'
} else {
  Step 3 'ข้ามขั้นสร้างตาราง (-SkipSchema)'
}

# ส่งเป็น array — ถ้าใส่สตริงว่างเข้าไป node จะได้ argument ว่างติดมาด้วย
$onlyArg = @()
if ($Only) { $onlyArg = @("--only=$Only") }

# ── 4) สำรวจต้นทางก่อน ──────────────────────────────────────────────
Step 4 'สำรวจข้อมูลต้นทาง (ยังไม่เขียนอะไร)'
node scripts\migrate-sheets.mjs --inspect @onlyArg
if ($LASTEXITCODE -ne 0) { throw 'อ่านต้นทางไม่สำเร็จ — ตรวจการแชร์ลิงก์ของชีท และว่า Apps Script ยัง deploy อยู่ไหม' }

if (-not $Yes) {
  Write-Host ''
  $ans = Read-Host 'ดูตัวเลขข้างบนแล้ว ย้ายข้อมูลลง SQL เลยไหม? (y/N)'
  if ($ans -notmatch '^(y|yes|ใช่)$') { Write-Host 'ยกเลิก — ยังไม่ได้เขียนอะไรลงฐานข้อมูล' -ForegroundColor Yellow; exit 0 }
}

# ── 5) ย้ายจริง ────────────────────────────────────────────────────
Step 5 'ย้ายข้อมูลลง SQL'
node scripts\migrate-sheets.mjs @onlyArg
if ($LASTEXITCODE -ne 0) { throw 'ย้ายข้อมูลไม่สำเร็จ — ดูข้อความผิดพลาดด้านบน' }

# ── 6) ตรวจว่าครบ ──────────────────────────────────────────────────
Step 6 'เทียบจำนวน ต้นทาง ↔ SQL'
node scripts\migrate-sheets.mjs --verify @onlyArg

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  ย้ายข้อมูลเสร็จแล้ว — เหลือขั้นเดียวคือเปิดใช้จากหน้าเว็บ' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host '  ที่เครื่องนี้ — เปิด host API ให้หน้าเว็บเรียกผ่าน tunnel' -ForegroundColor White
Write-Host "       `$env:SHEETS_WRITE_KEY = '<สุ่มข้อความยาว ๆ>'   # ใช้ QCRD_WRITE_KEY เดิมก็ได้"
Write-Host '       node host-server\server.js'
Write-Host '       เช็กว่าพร้อม: http://localhost:14365/sheets/ping'
Write-Host ''
Write-Host '  ที่ Vercel — Settings > Environment Variables แล้ว Redeploy' -ForegroundColor White
Write-Host '       SHEETS_SOURCE    = sql'
Write-Host '       SHEETS_API_BASE  = <URL ของ host API>   # ไม่ตั้ง = ใช้ STORE_API_BASE เดิม'
Write-Host '       SHEETS_WRITE_KEY = <ค่าเดียวกับเครื่องนี้>'
Write-Host ''
Write-Host '  รายละเอียดทั้งหมด: docs\sheets-sql-migration.md' -ForegroundColor DarkGray
