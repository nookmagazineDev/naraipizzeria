# ════════════════════════════════════════════════════════════
#  migrate-qcrd.ps1 — ย้าย QC/RD (เมนู · สูตร BOM · วัตถุดิบ) จาก Google Sheets ไป SQL Server
#  รันที่เครื่องออฟฟิศ (เครื่องที่ต่อ SQL Server ได้) จากโฟลเดอร์รีโป naraipizzeria
#
#  วิธีใช้ — เปิด PowerShell ที่โฟลเดอร์รีโป แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\migrate-qcrd.ps1
#
#  ทำให้ครบทุกขั้นในรอบเดียว:
#     1) โหลดรหัสฐานข้อมูลจาก host-server\db.env.ps1 (ถ้ามี) แล้วเติมค่าที่ขาด
#     2) npm install (เฉพาะเมื่อยังไม่มี package mssql)
#     3) สร้างตาราง/เพิ่มคอลัมน์จาก docs\schema-qcrd.sql
#     4) สำรวจชีท (--inspect) แล้วให้ยืนยันก่อนเขียนจริง
#     5) ย้ายข้อมูลจริง
#     6) เทียบจำนวนแถวชีทกับ SQL (--verify)
#
#  ตัวเลือก
#     -Yes           ไม่ต้องถามยืนยัน (ใช้ตอนรันซ้ำ/รันอัตโนมัติ)
#     -SkipSchema    ข้ามขั้นสร้างตาราง (เคยรันแล้ว)
#     -Only menu,bom ย้ายเฉพาะบางชุด (group,menu,bom,item)
#     -Db ชื่อฐาน     ฐานปลายทาง (ค่าเริ่มต้น InventoryNarai)
#
#  ⚠️ ไฟล์นี้ต้องบันทึกเป็น UTF-8 "พร้อม BOM" เท่านั้น
#     Windows PowerShell 5.1 (ตัวที่ติดมากับ Windows Server) อ่านไฟล์ .ps1 ที่ไม่มี BOM
#     เป็น ANSI ตาม codepage ของเครื่อง ทำให้ข้อความไทยกลายเป็นขยะแล้ว parser พังทั้งไฟล์
#     ขึ้น error แปลก ๆ อย่าง "Missing closing '}'" ทั้งที่วงเล็บครบ
#     เครื่องมือแก้ไฟล์บางตัวตัด BOM ทิ้งเงียบ ๆ — แก้ไฟล์นี้แล้วเช็ก BOM ทุกครั้ง
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

# ตารางสต๊อก/QC/RD อยู่บน SQLEXPRESS (คนละอินสแตนซ์กับ NaraiPos ที่ค่า default เป็น localhost)
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

# ── 3) สร้างตาราง + เพิ่มคอลัมน์ ─────────────────────────────────────
if (-not $SkipSchema) {
  Step 3 'สร้างตาราง/เพิ่มคอลัมน์ จาก docs\schema-qcrd.sql'
  $sqlcmd = (Get-Command sqlcmd -ErrorAction SilentlyContinue).Source
  if ($sqlcmd) {
    & $sqlcmd -S $env:QCRD_DB_SERVER -U $env:QCRD_DB_USER -P $env:QCRD_DB_PASSWORD -i 'docs\schema-qcrd.sql'
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาด้วย sqlcmd ไม่สำเร็จ' }
  } else {
    Warn 'ไม่พบ sqlcmd — ใช้ตัวรันของ node แทน (ผลเหมือนกัน)'
    node scripts\run-sql.mjs docs\schema-qcrd.sql
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาไม่สำเร็จ' }
  }
  Ok 'ตารางพร้อมแล้ว (รันซ้ำได้ ไม่ทับของเดิม)'
} else {
  Step 3 'ข้ามขั้นสร้างตาราง (-SkipSchema)'
}

# ส่งเป็น array — ถ้าใส่สตริงว่างเข้าไป node จะได้ argument ว่างติดมาด้วย
$onlyArg = @()
if ($Only) { $onlyArg = @("--only=$Only") }

# ── 4) สำรวจชีทก่อน ─────────────────────────────────────────────────
Step 4 'สำรวจข้อมูลในชีท (ยังไม่เขียนอะไร)'
node scripts\migrate-qcrd.mjs --inspect @onlyArg
if ($LASTEXITCODE -ne 0) { throw 'อ่านชีทไม่สำเร็จ — ตรวจการแชร์ลิงก์ของชีทต้นทุนเมนู' }

if (-not $Yes) {
  Write-Host ''
  $ans = Read-Host 'ดูตัวเลขข้างบนแล้ว ย้ายข้อมูลลง SQL เลยไหม? (y/N)'
  if ($ans -notmatch '^(y|yes|ใช่)$') { Write-Host 'ยกเลิก — ยังไม่ได้เขียนอะไรลงฐานข้อมูล' -ForegroundColor Yellow; exit 0 }
}

# ── 5) ย้ายจริง ────────────────────────────────────────────────────
Step 5 'ย้ายข้อมูลลง SQL'
node scripts\migrate-qcrd.mjs @onlyArg
if ($LASTEXITCODE -ne 0) { throw 'ย้ายข้อมูลไม่สำเร็จ — ดูข้อความผิดพลาดด้านบน' }

# ── 6) ตรวจว่าครบ ──────────────────────────────────────────────────
Step 6 'เทียบจำนวนแถว ชีท ↔ SQL'
node scripts\migrate-qcrd.mjs --verify @onlyArg

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host '  ย้ายข้อมูลเสร็จแล้ว — เหลือขั้นเดียวคือเปิดใช้จากหน้าเว็บ' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host '  ทางที่ 1 (ง่ายสุด) ให้ Vercel ต่อ SQL ตรง — ไม่ต้องแตะเครื่องนี้อีก' -ForegroundColor White
Write-Host '       Vercel > Settings > Environment Variables แล้ว Redeploy'
Write-Host '       QCRD_SOURCE = sql'
Write-Host '       (ถ้ายังไม่มี HR_DB_USER/HR_DB_PASSWORD บน Vercel ให้ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD ด้วย)'
Write-Host '       login ที่ใช้ต้องมีสิทธิ์ในฐาน InventoryNarai — ส่วนให้สิทธิ์อยู่ท้าย docs\schema-qcrd.sql'
Write-Host ''
Write-Host '  ทางที่ 2 ผ่าน host API (เมื่อไม่อยากให้ Vercel ต่อ SQL ตรง)' -ForegroundColor White
Write-Host "       เครื่องนี้: `$env:QCRD_WRITE_KEY = '<สุ่มข้อความยาว ๆ>' แล้ว node host-server\server.js"
Write-Host '       Vercel:   QCRD_SOURCE=sql · QCRD_API_BASE=<URL ของ host API> · QCRD_WRITE_KEY=<ค่าเดียวกัน>'
Write-Host ''
Write-Host '  รายละเอียดทั้งหมด: docs\qcrd-sql-migration.md' -ForegroundColor DarkGray
