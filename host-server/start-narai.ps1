# ════════════════════════════════════════════════════════════
#  start-narai.ps1
#  เปิด Narai API (port 14365) + Cloudflare Quick Tunnel
#  แล้วแสดง URL (xxx.trycloudflare.com) สำหรับเอาไปตั้ง
#  STORE_API_BASE บน Vercel
#
#  วิธีใช้ (คลิกขวา > Run with PowerShell  หรือ):
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1
# ════════════════════════════════════════════════════════════
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

  # 2) หา cloudflared
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cf) {
    foreach ($p in @(
      "$env:ProgramFiles\cloudflared\cloudflared.exe",
      "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) {
      if (Test-Path $p) { $cf = $p; break }
    }
  }
  if (-not $cf) { throw "ไม่พบ cloudflared — ติดตั้งด้วย: winget install Cloudflare.cloudflared" }

  # 3) เริ่ม API ถ้ายังไม่รัน
  $listening = (Test-NetConnection -ComputerName localhost -Port 14365 -WarningAction SilentlyContinue).TcpTestSucceeded
  if (-not $listening) {
    Write-Host "▶ เริ่ม Narai API (port 14365)..." -ForegroundColor Cyan
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $here -WindowStyle Normal
    Start-Sleep -Seconds 3
  } else {
    Write-Host "✓ API รันอยู่แล้วที่ port 14365" -ForegroundColor Green
  }

  # 4) เปิด Cloudflare Quick Tunnel
  $log = Join-Path $env:TEMP "narai-cf.log"
  $out = "$log.out"
  Remove-Item $log,$out -Force -ErrorAction SilentlyContinue
  Write-Host "▶ เปิด Cloudflare Quick Tunnel..." -ForegroundColor Cyan
  $cfProc = Start-Process -FilePath $cf `
    -ArgumentList @('tunnel','--no-autoupdate','--url','http://localhost:14365') `
    -RedirectStandardError $log -RedirectStandardOutput $out -PassThru -WindowStyle Hidden

  # 5) รอ URL
  $url = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value; break }
    }
  }
  if (-not $url) { throw "ไม่ได้ URL ภายใน 30 วิ — ดู log: $log" }

  # 6) แสดงผล + คัดลอก URL
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

  # 7) คงไว้ + สตรีม log
  Get-Content $log -Wait -Tail 2
}
finally {
  if ($cfProc -and -not $cfProc.HasExited) {
    Write-Host "`n■ ปิด tunnel..." -ForegroundColor Yellow
    Stop-Process -Id $cfProc.Id -Force -ErrorAction SilentlyContinue
  }
}
