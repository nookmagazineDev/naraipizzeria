# ════════════════════════════════════════════════════════════
#  start-narai.ps1
#  เปิด Narai API (port 14365) + Cloudflare Quick Tunnel
#  แล้วแสดง URL (xxx.trycloudflare.com) สำหรับเอาไปตั้ง
#  STORE_API_BASE บน Vercel
#
#  วิธีใช้ (คลิกขวา > Run with PowerShell  หรือ):
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1
#
#  หลัง git pull ต้องใช้ -Restart ด้วย ไม่งั้นตัวเก่าที่ค้างอยู่จะไม่ถูกปิด
#  แล้วโค้ดใหม่จะไม่ถูกโหลด (อาการ: endpoint ใหม่ขึ้น HTTP 404 ทั้งที่ pull แล้ว):
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart
#
#  ⚠️ เครื่องที่เปิด tunnel ถาวรไว้แล้ว (STORE_API_BASE เป็นโดเมนของตัวเอง เช่น
#  api.khanoykorshabu.com ไม่ใช่ xxx.trycloudflare.com) ให้ใส่ -NoTunnel ด้วยเสมอ
#  จะได้แค่รีสตาร์ท API เฉย ๆ ไม่ไปยุ่งกับ tunnel ที่รันอยู่ และไม่ต้องมี cloudflared ในเครื่อง:
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart -NoTunnel
# ════════════════════════════════════════════════════════════
param(
  [switch]$Restart,    # ปิด API ตัวเก่าที่ถือ port 14365 อยู่ก่อน แล้วเปิดใหม่ (ต้องใช้ทุกครั้งหลัง git pull)
  [switch]$NoTunnel    # รีสตาร์ทเฉพาะ API ไม่แตะ tunnel — สำหรับเครื่องที่เปิด tunnel ถาวรไว้แยกแล้ว
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfProc = $null

try {
  # 1) โหลดรหัส DB จากไฟล์ลับ (ไม่ขึ้น git) ถ้ามี
  $secret = Join-Path $here 'db.env.ps1'
  if (Test-Path $secret) {
    . $secret
    Write-Host "✓ โหลดค่า DB จาก db.env.ps1" -ForegroundColor Green
  }
  if (-not $env:DB_PASSWORD) {
    Write-Host "⚠️  ยังไม่ได้ตั้ง DB_PASSWORD" -ForegroundColor Yellow
    Write-Host "    สร้างไฟล์: $secret" -ForegroundColor Yellow
    Write-Host "    ใส่บรรทัด:  `$env:DB_PASSWORD = 'รหัสจริง'" -ForegroundColor Yellow
  }

  # 2) เริ่ม API ถ้ายังไม่รัน
  $listening = (Test-NetConnection -ComputerName localhost -Port 14365 -WarningAction SilentlyContinue).TcpTestSucceeded
  if ($listening -and $Restart) {
    # node ที่รันอยู่ถือโค้ดเวอร์ชันตอนที่มันเริ่ม — git pull เฉย ๆ ไม่ทำให้ endpoint ใหม่โผล่
    Write-Host "■ ปิด API ตัวเก่าที่ถือ port 14365 อยู่..." -ForegroundColor Yellow
    Get-NetTCPConnection -LocalPort 14365 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    $listening = $false
  }
  if (-not $listening) {
    Write-Host "▶ เริ่ม Narai API (port 14365)..." -ForegroundColor Cyan
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $here -WindowStyle Normal
    Start-Sleep -Seconds 3
  } else {
    Write-Host "✓ API รันอยู่แล้วที่ port 14365" -ForegroundColor Green
  }

  # 3) เช็กว่า API ตอบจริง — ขึ้น 404 ตรงนี้แปลว่าโค้ดใหม่ยังไม่ถูกโหลด (ลืม -Restart)
  try {
    $null = Invoke-RestMethod -Uri 'http://localhost:14365/ping' -TimeoutSec 10
    Write-Host "✓ API ตอบแล้ว (/ping)" -ForegroundColor Green
  } catch {
    Write-Host "⚠️  API ยังไม่ตอบที่ /ping — $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "    ดูหน้าต่าง node ที่เพิ่งเปิดว่ามี error อะไรขึ้น" -ForegroundColor Yellow
  }

  # 4) tunnel — ข้ามไปเลยถ้าเครื่องนี้เปิด tunnel ถาวรไว้แยกแล้ว
  if ($NoTunnel) {
    Write-Host ""
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ API พร้อมใช้งานที่ http://localhost:14365" -ForegroundColor Green
    Write-Host "  (ข้าม tunnel ตาม -NoTunnel — ตัวที่เปิดถาวรไว้ยังทำงานตามเดิม)" -ForegroundColor DarkGray
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    return
  }

  # หา cloudflared (เช็กตรงนี้ ไม่ใช่ตั้งแต่ต้นไฟล์ — API จะได้ถูกรีสตาร์ทไปแล้ว
  # ต่อให้เครื่องนี้ไม่มี cloudflared เพราะเปิด tunnel ด้วยวิธีอื่น)
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cf) {
    foreach ($p in @(
      "$env:ProgramFiles\cloudflared\cloudflared.exe",
      "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) {
      if (Test-Path $p) { $cf = $p; break }
    }
  }
  if (-not $cf) {
    throw "ไม่พบ cloudflared — ถ้าเครื่องนี้เปิด tunnel ไว้แยกอยู่แล้ว ให้สั่งใหม่โดยใส่ -NoTunnel " +
          "(API ถูกรีสตาร์ทไปเรียบร้อยแล้ว) หรือติดตั้งด้วย: winget install Cloudflare.cloudflared"
  }

  # 5) เปิด Cloudflare Quick Tunnel
  $log = Join-Path $env:TEMP "narai-cf.log"
  $out = "$log.out"
  Remove-Item $log,$out -Force -ErrorAction SilentlyContinue
  Write-Host "▶ เปิด Cloudflare Quick Tunnel..." -ForegroundColor Cyan
  $cfProc = Start-Process -FilePath $cf `
    -ArgumentList @('tunnel','--no-autoupdate','--url','http://localhost:14365') `
    -RedirectStandardError $log -RedirectStandardOutput $out -PassThru -WindowStyle Hidden

  # 6) รอ URL
  $url = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value; break }
    }
  }
  if (-not $url) { throw "ไม่ได้ URL ภายใน 30 วิ — ดู log: $log" }

  # 7) แสดงผล + คัดลอก URL
  Write-Host ""
  Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
  Write-Host "  ✅ Tunnel พร้อมใช้งาน" -ForegroundColor Green
  Write-Host "  URL : $url" -ForegroundColor White
  Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
  Write-Host ""
  Write-Host "📋 เอา URL ไปตั้งบน Vercel:" -ForegroundColor Cyan
  Write-Host "   Project > Settings > Environment Variables"
  Write-Host "   STORE_API_BASE = $url"
  Write-Host "   แล้ว Redeploy"
  Write-Host ""
  try { Set-Clipboard -Value $url; Write-Host "(คัดลอก URL ลง clipboard ให้แล้ว)" -ForegroundColor DarkGray } catch {}
  Write-Host ""
  Write-Host "ปิดหน้าต่างนี้ / Ctrl+C = ปิด tunnel" -ForegroundColor DarkGray
  Write-Host "──────── log สด ────────" -ForegroundColor DarkGray

  # 8) คงไว้ + สตรีม log
  Get-Content $log -Wait -Tail 2
}
finally {
  if ($cfProc -and -not $cfProc.HasExited) {
    Write-Host "`n■ ปิด tunnel..." -ForegroundColor Yellow
    Stop-Process -Id $cfProc.Id -Force -ErrorAction SilentlyContinue
  }
}
