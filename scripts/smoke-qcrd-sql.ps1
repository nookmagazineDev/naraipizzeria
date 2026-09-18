# ════════════════════════════════════════════════════════════
#  smoke-qcrd-sql.ps1 — ทดสอบฝั่งเขียนของ QC/RD กับฐานจริง (รันที่เครื่องออฟฟิศ)
#
#  วิธีใช้ — เปิด PowerShell ที่โฟลเดอร์รีโป แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\smoke-qcrd-sql.ps1
#     powershell -ExecutionPolicy Bypass -File .\scripts\smoke-qcrd-sql.ps1 -Keep
#
#  มีไว้เพราะเรียก node scripts\smoke-qcrd-sql.mjs ตรง ๆ จะไม่มีรหัสฐานข้อมูลใน session
#  แล้วไปตายที่ "Login failed for user 'sa'" ทั้งที่รหัสมีอยู่แล้วใน host-server\db.env.ps1
#  ตัวนี้ . (dot-source) ไฟล์นั้นให้ก่อน เหมือนที่ start-narai.ps1 กับ migrate-qcrd.ps1 ทำ
#
#  ⚠️ ไฟล์นี้ต้องบันทึกเป็น UTF-8 "พร้อม BOM" เท่านั้น (เหตุผลเดียวกับ migrate-qcrd.ps1)
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param([switch]$Keep)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repo

$secret = Join-Path $repo 'host-server\db.env.ps1'
if (Test-Path $secret) {
  . $secret
  Write-Host "✓ โหลดค่าจาก host-server\db.env.ps1" -ForegroundColor Green
} else {
  Write-Host "! ไม่เจอ host-server\db.env.ps1 — ถ้าต่อฐานไม่ได้ ให้ก๊อปจาก db.env.ps1.example แล้วใส่รหัสจริง" -ForegroundColor Yellow
}

# db.env.ps1 ตั้ง DB_* ไว้สำหรับฐาน NaraiPos — ฐานของ QC/RD คนละตัว เติมให้ตรงนี้ถ้ายังไม่ได้ตั้ง
if (-not $env:QCRD_DB_NAME) { $env:QCRD_DB_NAME = 'InventoryNarai' }

if (-not (Test-Path (Join-Path $repo 'node_modules\mssql'))) {
  Write-Host "`n[1] ยังไม่มี package mssql — รัน npm install ก่อน" -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install ไม่สำเร็จ' }
}

Write-Host "`n[2] ยิงเข้าฐานจริงแล้วอ่านกลับมาตรวจ" -ForegroundColor Cyan
if ($Keep) { node scripts/smoke-qcrd-sql.mjs --keep } else { node scripts/smoke-qcrd-sql.mjs }
exit $LASTEXITCODE
