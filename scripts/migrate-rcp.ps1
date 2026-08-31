# ════════════════════════════════════════════════════════════
#  migrate-rcp.ps1 — นำเข้าสูตรฝั่ง POS (แท็บ RcpDtls) เข้า SQL Server
#  รันที่เครื่องออฟฟิศ (เครื่องที่ต่อ SQL Server ได้) จากโฟลเดอร์รีโป naraipizzeria
#
#  วิธีใช้ — เปิด PowerShell ที่โฟลเดอร์รีโป แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\migrate-rcp.ps1 -File Kios_Dtls.xlsx
#
#  ทำให้ครบทุกขั้นในรอบเดียว:
#     1) โหลดรหัสฐานข้อมูลจาก host-server\db.env.ps1 (ถ้ามี) แล้วเติมค่าที่ขาด
#     2) npm install (เฉพาะเมื่อยังไม่มี package mssql / xlsx)
#     3) สร้างตารางจาก docs\schema-rcp.sql
#     4) อ่านไฟล์ .xlsx แบบไม่เขียนอะไร (--dry-run) แล้วให้ยืนยันก่อนเขียนจริง
#     5) นำเข้าจริง
#
#  ตัวเลือก
#     -File <ไฟล์>   ไฟล์ .xlsx ที่ export มาจากชีท (ค่าเริ่มต้น Kios_Dtls.xlsx)
#     -Yes           ไม่ต้องถามยืนยัน (ใช้ตอนรันซ้ำ/รันอัตโนมัติ)
#     -SkipSchema    ข้ามขั้นสร้างตาราง (เคยรันแล้ว)
#     -Tab <ชื่อแท็บ> แท็บในไฟล์ (ค่าเริ่มต้น RcpDtls)
#     -Server <เครื่อง> เครื่อง SQL (ค่าเริ่มต้น localhost\SQLEXPRESS)
#                     รันบนเครื่องที่มี SQL อยู่ให้ใช้ค่าเริ่มต้น · รันจากเครื่องอื่นใช้ inventory.dyndns.tv
#     -User <user>   login ของ SQL (ค่าเริ่มต้น sa)
#     -Trusted       เข้า SQL ด้วยสิทธิ์ Windows ที่ล็อกอินอยู่ ไม่ต้องใช้ user/รหัสของ SQL เลย
#                    (ใช้ได้เมื่อรันบนเครื่องที่มี SQL Server และบัญชี Windows นั้นมีสิทธิ์ในฐาน)
#     -DbName <ชื่อฐาน> ฐานปลายทาง (ค่าเริ่มต้น InventoryNarai)
#
#  ⚠️ ไฟล์นี้ต้องบันทึกเป็น UTF-8 "พร้อม BOM" เท่านั้น
#     Windows PowerShell 5.1 อ่านไฟล์ .ps1 ที่ไม่มี BOM เป็น ANSI ตาม codepage ของเครื่อง
#     ทำให้ข้อความไทยกลายเป็นขยะแล้ว parser พังทั้งไฟล์ (เหมือนที่เขียนไว้ใน migrate-qcrd.ps1)
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$File = 'Kios_Dtls.xlsx',
  [switch]$Yes,
  [switch]$SkipSchema,
  [string]$Tab = 'RcpDtls',
  [string]$DbName = '',
  [string]$Server = '',
  [string]$User = '',
  [switch]$Trusted
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repo

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    ⚠️  $text" -ForegroundColor Yellow }

# ── 0) ไฟล์ต้นทาง ────────────────────────────────────────────────────
if (-not (Test-Path $File)) {
  throw "ไม่พบไฟล์ $File — วางไฟล์ที่ export จากชีทไว้ในโฟลเดอร์รีโป หรือระบุ -File <path> เต็ม ๆ"
}
$File = (Resolve-Path $File).Path

# ── 1) ค่าเชื่อมต่อฐานข้อมูล ─────────────────────────────────────────
Step 1 'ค่าเชื่อมต่อฐานข้อมูล'
$secret = Join-Path $repo 'host-server\db.env.ps1'
if (Test-Path $secret) { . $secret; Ok "โหลดค่าจาก host-server\db.env.ps1" }

# -Server/-User ที่ส่งมาทางบรรทัดคำสั่งชนะทุกอย่าง รวมถึง env ที่ค้างอยู่จากคำสั่งก่อนหน้าในหน้าต่างเดิม
# (เคสจริงที่เจอ: ตั้ง QCRD_DB_SERVER ไว้เป็น inventory.dyndns.tv แล้วมารันบนเครื่องที่มี SQL อยู่
#  ต่อออกเน็ตแล้ววนกลับเข้าเครื่องตัวเองไม่ได้ ขึ้น Login timeout ทั้งที่ฐานอยู่ตรงหน้า)
if ($Server) { $env:QCRD_DB_SERVER = $Server }
if ($User)   { $env:QCRD_DB_USER   = $User }

# ตาราง rcp_* อยู่ฐานเดียวกับ QC/RD บน SQLEXPRESS (คนละอินสแตนซ์กับ NaraiPos)
if (-not $env:QCRD_DB_SERVER)   { $env:QCRD_DB_SERVER = if ($env:DB_SERVER -and $env:DB_SERVER -match '\\') { $env:DB_SERVER } else { 'localhost\SQLEXPRESS' } }
if (-not $env:QCRD_DB_NAME)     { $env:QCRD_DB_NAME = if ($DbName) { $DbName } else { 'InventoryNarai' } }
if ($DbName)                    { $env:QCRD_DB_NAME = $DbName }
if ($Trusted) {
  Ok "ปลายทาง: $($env:QCRD_DB_SERVER)/$($env:QCRD_DB_NAME)  (สิทธิ์ Windows ของ $env:USERNAME — ไม่ใช้รหัส SQL)"
} else {
  if (-not $env:QCRD_DB_USER)     { $env:QCRD_DB_USER = if ($env:DB_USER) { $env:DB_USER } else { 'sa' } }
  if (-not $env:QCRD_DB_PASSWORD) { $env:QCRD_DB_PASSWORD = $env:DB_PASSWORD }
  if (-not $env:QCRD_DB_PASSWORD) {
    $sec = Read-Host "รหัสผ่านของ $($env:QCRD_DB_USER) บน $($env:QCRD_DB_SERVER)" -AsSecureString
    $env:QCRD_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  Ok "ปลายทาง: $($env:QCRD_DB_SERVER)/$($env:QCRD_DB_NAME)  (user: $($env:QCRD_DB_USER))"
}

# -E = ใช้สิทธิ์ Windows ที่ล็อกอินอยู่ · ไม่งั้นส่ง user/รหัสไปตามปกติ
$auth = if ($Trusted) { @('-E') } else { @('-U', $env:QCRD_DB_USER, '-P', $env:QCRD_DB_PASSWORD) }

# หา sqlcmd ครั้งเดียวตรงนี้ ใช้ทั้งขั้นสร้างตารางและขั้นนำเข้า
# (เคยหาไว้ในบล็อก -not $SkipSchema ทำให้สั่ง -SkipSchema -Trusted แล้วขั้นนำเข้าได้ค่าว่าง)
$sqlcmd = (Get-Command sqlcmd -ErrorAction SilentlyContinue).Source
if ($Trusted -and -not $sqlcmd) {
  throw 'โหมด -Trusted ต้องมี sqlcmd (ตัวรันของ node ต่อแบบสิทธิ์ Windows ไม่ได้) — ลง SQL Server Command Line Utilities ก่อน'
}

# ── 2) package ที่สคริปต์ใช้ ─────────────────────────────────────────
Step 2 'ตรวจ package mssql / xlsx'
if ((-not (Test-Path (Join-Path $repo 'node_modules\mssql'))) -or (-not (Test-Path (Join-Path $repo 'node_modules\xlsx')))) {
  Write-Host '    กำลัง npm install (ครั้งแรกใช้เวลาสักครู่)...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install ไม่สำเร็จ' }
}
Ok 'พร้อมใช้งาน'

# ── 3) สร้างตาราง ───────────────────────────────────────────────────
if (-not $SkipSchema) {
  Step 3 'สร้างตาราง rcp_recipe / rcp_line จาก docs\schema-rcp.sql'
  if ($sqlcmd) {
    & $sqlcmd -S $env:QCRD_DB_SERVER -d $env:QCRD_DB_NAME @auth -i 'docs\schema-rcp.sql'
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาด้วย sqlcmd ไม่สำเร็จ' }
  } else {
    Warn 'ไม่พบ sqlcmd — ใช้ตัวรันของ node แทน (ผลเหมือนกัน)'
    node scripts\run-sql.mjs docs\schema-rcp.sql
    if ($LASTEXITCODE -ne 0) { throw 'รันสคีมาไม่สำเร็จ' }
  }
  Ok 'ตารางพร้อมแล้ว (รันซ้ำได้ ไม่ทับของเดิม)'
} else {
  Step 3 'ข้ามขั้นสร้างตาราง (-SkipSchema)'
}

# ── 4) อ่านไฟล์ก่อน ไม่เขียนอะไร ─────────────────────────────────────
Step 4 'อ่านไฟล์และตรวจข้อมูล (ยังไม่เขียนลงฐาน)'
node scripts\migrate-rcp.mjs $File --tab $Tab --dry-run
if ($LASTEXITCODE -ne 0) { throw 'อ่านไฟล์ไม่สำเร็จ — ดูข้อความผิดพลาดด้านบน' }

if (-not $Yes) {
  Write-Host ''
  Write-Host 'หมายเหตุ: การนำเข้าจะล้างสูตรเดิมในตาราง rcp_* ทั้งหมดแล้วใส่ชุดใหม่จากไฟล์นี้' -ForegroundColor Yellow
  Write-Host '          (อยู่ในทรานแซกชันเดียว ล้มกลางทางของเดิมยังอยู่ครบ)' -ForegroundColor Yellow
  $ans = Read-Host 'ดูตัวเลขข้างบนแล้ว นำเข้าลง SQL เลยไหม? (y/N)'
  if ($ans -notmatch '^(y|yes|ใช่)$') { Write-Host 'ยกเลิก — ยังไม่ได้เขียนอะไรลงฐานข้อมูล' -ForegroundColor Yellow; exit 0 }
}

# ── 5) นำเข้าจริง ───────────────────────────────────────────────────
Step 5 'นำเข้าลง SQL'
if ($Trusted) {
  # driver ที่ node ใช้ (tedious) ต่อแบบสิทธิ์ Windows ไม่ได้ — ให้ node ปั้นคำสั่งเป็นไฟล์
  # แล้วส่งให้ sqlcmd -E เอาไปรันแทน ผลลัพธ์ในฐานเหมือนกันทุกอย่าง
  $tmp = Join-Path $env:TEMP 'rcp-import.sql'
  node scripts\migrate-rcp.mjs $File --tab $Tab --emit-sql $tmp
  if ($LASTEXITCODE -ne 0) { throw 'ปั้นไฟล์คำสั่งไม่สำเร็จ' }
  & $sqlcmd -S $env:QCRD_DB_SERVER -d $env:QCRD_DB_NAME @auth -i $tmp
  if ($LASTEXITCODE -ne 0) { throw 'นำเข้าไม่สำเร็จ — ดูข้อความผิดพลาดด้านบน' }
  Remove-Item $tmp -ErrorAction SilentlyContinue
} else {
  node scripts\migrate-rcp.mjs $File --tab $Tab
  if ($LASTEXITCODE -ne 0) { throw 'นำเข้าไม่สำเร็จ — ดูข้อความผิดพลาดด้านบน' }
}

Write-Host ''
Write-Host 'เสร็จแล้ว — เปิดหน้า QC/RD > เมนู แล้วดูบรรทัดบนหัวหน้าว่า "เติมจากสูตร POS อีก N เมนู"' -ForegroundColor Green
Write-Host 'ถ้ายังไม่ขึ้น ให้ตั้ง QCRD_DB_USER / QCRD_DB_PASSWORD บน Vercel ด้วย (หน้าเว็บต่อฐานคนละทางกับสคริปต์นี้)' -ForegroundColor Yellow
