# ════════════════════════════════════════════════════════════
#  fix-sales-index.ps1 — แก้ "หน้าแดชบอร์ดดึงยอดขายไม่ขึ้น / ขึ้น HTTP 500"
#  สร้าง index ตามวันที่ให้ตาราง Cpaid/Ctrans บนฐาน NaraiPos (ไม่ต้องเปิด SSMS)
#  รันที่เครื่องออฟฟิศ (เครื่องที่มี SQL Server) จากโฟลเดอร์รีโป naraipizzeria
#
#  วิธีใช้ — เปิด PowerShell ที่โฟลเดอร์รีโป แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\fix-sales-index.ps1
#
#  ค่าเริ่มต้นจะทำแค่ขั้นที่ปลอดภัย (IX_Cpaid_Date — ตารางเล็ก ล็อกแค่ไม่กี่วินาที)
#  แล้วบอกเวลาที่วัดได้ก่อน/หลังแก้ให้ดู
#
#  ตัวเลือก
#     -Check    ดูอย่างเดียว ไม่สร้างอะไร (ใช้เช็กว่ามี index ครบหรือยัง)
#     -Ctrans   สร้าง IX_Ctrans_PostTime ด้วย (หน้ารายละเอียดรายการ)
#               ⚠️ ล็อกตาราง Ctrans หลายนาที = POS ทุกสาขาขายไม่ได้ ต้องทำตอนปิดร้านเท่านั้น
#     -Date     วันที่ที่ใช้จับเวลา (ค่าเริ่มต้น = เมื่อวาน) เช่น -Date 2026-09-09
#     -Yes      ไม่ต้องถามยืนยัน
#
#  ⚠️ ไฟล์นี้ต้องบันทึกเป็น UTF-8 "พร้อม BOM" เท่านั้น (เหตุผลเดียวกับ migrate-qcrd.ps1)
#     Windows PowerShell 5.1 อ่านไฟล์ที่ไม่มี BOM เป็น ANSI แล้วข้อความไทยพังทั้งไฟล์
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Ctrans,
  [string]$Date = '',
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repo

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    ⚠️  $text" -ForegroundColor Yellow }

# ── 1) ค่าเชื่อมต่อฐานข้อมูล (ชุดเดียวกับที่ host-server ใช้) ────────
Step 1 'ค่าเชื่อมต่อฐานข้อมูล'
$secret = Join-Path $repo 'host-server\db.env.ps1'
if (Test-Path $secret) { . $secret; Ok "โหลดค่าจาก host-server\db.env.ps1" }

if (-not $env:DB_SERVER) { $env:DB_SERVER = 'localhost' }
if (-not $env:DB_NAME)   { $env:DB_NAME = 'NaraiPos' }
if (-not $env:DB_USER)   { $env:DB_USER = 'SA' }
if (-not $env:DB_PASSWORD) {
  $sec = Read-Host "รหัสผ่านของ $($env:DB_USER) บน $($env:DB_SERVER)" -AsSecureString
  $env:DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
Ok "ปลายทาง: $($env:DB_SERVER)/$($env:DB_NAME)  (user: $($env:DB_USER))"

# ── 2) package ที่สคริปต์ใช้ ─────────────────────────────────────────
Step 2 'ตรวจ package mssql'
if (-not (Test-Path (Join-Path $repo 'node_modules\mssql'))) {
  Write-Host '    กำลัง npm install (ครั้งแรกใช้เวลาสักครู่)...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install ไม่สำเร็จ' }
}
Ok 'มี mssql พร้อมใช้งาน'

# ── 3) เตือนก่อนแตะตารางใหญ่ ────────────────────────────────────────
$flags = @()
if ($Check)  { $flags += '--check' }
if ($Ctrans) { $flags += '--ctrans' }
if ($Date)   { $flags += "--date=$Date" }

if ($Ctrans -and -not $Check -and -not $Yes) {
  Step 3 'ยืนยันก่อนสร้าง index บน Ctrans'
  Warn 'ตาราง Ctrans มี 7.5 ล้านแถว — ระหว่างสร้าง index ตารางจะถูกล็อกหลายนาที'
  Warn 'ตารางนี้คือที่ POS เขียนรายการขายลงทุกบิล ถ้าร้านยังเปิดอยู่ = ขายไม่ได้ทุกสาขา'
  $ans = Read-Host 'ตอนนี้ปิดร้านแล้วใช่ไหม พิมพ์ yes เพื่อไปต่อ'
  if ($ans -ne 'yes') { Write-Host 'ยกเลิก' -ForegroundColor Yellow; exit 1 }
}

# ── 4) ลงมือ ────────────────────────────────────────────────────────
Step 4 'ตรวจ/สร้าง index'
node scripts/fix-sales-index.mjs @flags
if ($LASTEXITCODE -ne 0) { throw 'สคริปต์ทำงานไม่สำเร็จ — อ่านข้อความ error ด้านบน' }

Write-Host "`n✓ เรียบร้อย" -ForegroundColor Green
if (-not $Check -and -not $Ctrans) {
  Write-Host '  ถ้าหน้า "รายละเอียดรายการ" ยังช้าอยู่ ให้รันซ้ำด้วย -Ctrans ตอนปิดร้าน' -ForegroundColor Yellow
}
