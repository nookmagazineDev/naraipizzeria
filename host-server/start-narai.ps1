# ════════════════════════════════════════════════════════════
#  start-narai.ps1
#  เปิด Narai API (พอร์ต 14365 หรือตาม env PORT) + Cloudflare Quick Tunnel
#
#  วิธีใช้ (คลิกขวา > Run with PowerShell  หรือ):
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1
#
#  หลัง git pull ต้องใช้ -Restart ด้วย ไม่งั้นตัวเก่าที่ค้างอยู่จะไม่ถูกปิด
#  แล้วโค้ดใหม่จะไม่ถูกโหลด (อาการ: endpoint ใหม่ขึ้น HTTP 404 ทั้งที่ pull แล้ว):
#     powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart
#
#  ⚠️ เครื่องที่ต่อเน็ตด้วย "named tunnel" อยู่แล้ว (cloudflared tunnel run --token-file
#     หรือ ngrok ที่ตั้ง domain ไว้ = URL คงที่ ไม่ใช่ xxx.trycloudflare.com) ห้ามเปิด
#     quick tunnel ซ้อน — สคริปต์จะตรวจให้เองแล้วรีสตาร์ทแค่ API พอ
#     สั่งตรง ๆ ก็ได้:  .\start-narai.ps1 -Restart -NoTunnel
# ════════════════════════════════════════════════════════════
param(
  [switch]$Restart,    # ปิด API ตัวเก่าที่ถือพอร์ตอยู่ก่อน แล้วเปิดใหม่ (ใช้ทุกครั้งหลัง git pull)
  [switch]$NoTunnel    # รีสตาร์ทแค่ API ไม่ต้องแตะ tunnel (เครื่องที่มี named tunnel อยู่แล้ว)
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

  # 2) พอร์ตที่ server.js จะฟัง — ตั้งใน db.env.ps1 ด้วย $env:PORT ได้ (เผื่อ 14365 ชนกับ API ตัวอื่น)
  $port = if ($env:PORT) { [int]$env:PORT } else { 14365 }

  # 3) เริ่ม API ถ้ายังไม่รัน
  $listening = (Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
  if ($listening -and $Restart) {
    # node ที่รันอยู่ถือโค้ดเวอร์ชันตอนที่มันเริ่ม — git pull เฉย ๆ ไม่ทำให้ endpoint ใหม่โผล่
    Write-Host "■ ปิด API ตัวเก่าที่ถือ port $port อยู่..." -ForegroundColor Yellow
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    $listening = $false
  }
  if (-not $listening) {
    Write-Host "▶ เริ่ม Narai API (port $port)..." -ForegroundColor Cyan
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $here -WindowStyle Normal
    Start-Sleep -Seconds 3
  } else {
    Write-Host "✓ API รันอยู่แล้วที่ port $port" -ForegroundColor Green
  }

  # 4) มี tunnel ที่ตั้งไว้ถาวรอยู่แล้วไหม — มีแล้วห้ามเปิด quick tunnel ซ้อน
  #    named tunnel (cloudflared tunnel run / ngrok --domain) ให้ URL คงที่ซึ่งตั้งไว้บน Vercel แล้ว
  #    ถ้าเปิด quick tunnel ทับ จะได้ URL ใหม่ที่ไม่มีใครใช้ แถมกินทรัพยากรฟรี ๆ
  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'cloudflared|ngrok|frpc' -and $_.CommandLine -notmatch 'trycloudflare|--url' }
  if ($NoTunnel -or $running) {
    Write-Host ""
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ API พร้อมใช้งานที่ port $port" -ForegroundColor Green
    if ($running) {
      Write-Host "  tunnel ที่ตั้งไว้ถาวรรันอยู่แล้ว (PID $($running[0].ProcessId) $($running[0].Name))" -ForegroundColor Green
      Write-Host "  URL เดิมใช้ได้ต่อ ไม่ต้องแก้ env บน Vercel" -ForegroundColor Green
    } else {
      Write-Host "  ข้ามการเปิด tunnel ตามที่สั่ง (-NoTunnel)" -ForegroundColor DarkGray
    }
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""
    Write-Host "เช็กว่าโค้ดใหม่ถูกโหลดแล้วจริง:" -ForegroundColor Cyan
    Write-Host "   curl.exe http://localhost:$port/qcrd/ping"
    Write-Host "   curl.exe http://localhost:$port/sheets/ping"
    return
  }

  # 5) ไม่มี tunnel ถาวร — หา cloudflared แล้วเปิด Quick Tunnel ให้
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cf) {
    foreach ($p in @(
      "$env:ProgramFiles\cloudflared\cloudflared.exe",
      "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
      "C:\tools\cloudflared.exe")) {
      if (Test-Path $p) { $cf = $p; break }
    }
  }
  if (-not $cf) {
    throw "ไม่พบ cloudflared — ติดตั้งด้วย: winget install Cloudflare.cloudflared`n" +
          "(ถ้าเครื่องนี้ต่อเน็ตด้วยวิธีอื่นอยู่แล้ว ใช้ -NoTunnel เพื่อรีสตาร์ทแค่ API)"
  }

  $log = Join-Path $env:TEMP "narai-cf.log"
  $out = "$log.out"
  Remove-Item $log,$out -Force -ErrorAction SilentlyContinue
  Write-Host "▶ เปิด Cloudflare Quick Tunnel..." -ForegroundColor Cyan
  $cfProc = Start-Process -FilePath $cf `
    -ArgumentList @('tunnel','--no-autoupdate','--url',"http://localhost:$port") `
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
