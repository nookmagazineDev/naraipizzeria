# ════════════════════════════════════════════════════════════
#  smoke-pages.ps1 — ไล่เช็กทุกหน้าของเว็บ office (รันที่เครื่องเซิร์ฟเวอร์)
#
#  วิธีใช้ — เปิด PowerShell แล้วรันบรรทัดเดียว:
#     powershell -ExecutionPolicy Bypass -File .\scripts\smoke-pages.ps1
#     powershell -ExecutionPolicy Bypass -File .\scripts\smoke-pages.ps1 -Branch CRM -Day 2026-10-29
#
#  ทำ 2 อย่าง:
#    1) ตรวจไฟล์ env ของเว็บ — ค่า "[SENSITIVE]" ที่ดึงมาจาก Vercel, ตัวแปรซ้ำ, สวิตช์ SOURCE
#       และกุญแจเขียนตรงกับ service NaraiAPI ไหม (ไม่พิมพ์ค่าลับออกมา)
#    2) ล็อกอินแล้วเรียก /api/* ของทุกเมนูแบบ "อ่านอย่างเดียว" — ไม่บันทึก/แก้/ลบอะไรทั้งสิ้น
#       ฝั่งเขียนใช้กุญแจชุดเดียวกับข้อ 1 ถ้าข้อ 1 ผ่าน ฝั่งเขียนก็ไปถึงฐานได้
#
#  ⚠️ ไฟล์นี้ต้องบันทึกเป็น UTF-8 "พร้อม BOM" (Windows PowerShell 5.1 อ่านภาษาไทยเพี้ยนถ้าไม่มี)
# ════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3101',
  [string]$AppDir = 'C:\narai-local\naraipizzeria',
  [string]$Branch = 'CRM',
  [string]$Day = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd'),
  [string]$ApiService = 'NaraiAPI'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Line($color, $text) { Write-Host $text -ForegroundColor $color }

# ───────────────────────── 1) env ─────────────────────────
Line Cyan "`n== 1) ไฟล์ env ของเว็บ ($AppDir) =="

# Next.js โหลด .env.production.local ก่อน .env.local — ค่าในไฟล์แรกชนะ
$envFiles = @('.env.production.local', '.env.local') | ForEach-Object { Join-Path $AppDir $_ } | Where-Object { Test-Path $_ }
$web = @{}
foreach ($file in $envFiles) {
  $seen = @{}
  foreach ($raw in Get-Content $file -Encoding UTF8) {
    if ($raw -notmatch '^\s*([A-Z0-9_]+)\s*=(.*)$') { continue }
    $name = $Matches[1]; $value = $Matches[2].Trim().Trim('"').Trim("'")
    if ($seen.ContainsKey($name)) { Line Yellow "  ซ้ำ    $name มีหลายบรรทัดใน $(Split-Path $file -Leaf) — ลบให้เหลือบรรทัดเดียว" }
    $seen[$name] = $value
  }
  foreach ($k in $seen.Keys) { if (-not $web.ContainsKey($k)) { $web[$k] = $seen[$k] } }
}

$sensitive = $web.Keys | Where-Object { $web[$_] -eq '[SENSITIVE]' } | Sort-Object
foreach ($k in $sensitive) { Line Red "  ผิด    $k = [SENSITIVE] (ค่าหลอกจาก Vercel ไม่ใช่ค่าจริง)" }

foreach ($k in 'QCRD_SOURCE', 'SHEETS_SOURCE') {
  if ($web[$k] -eq 'sql') { Line Green "  ผ่าน   $k = sql" }
  else { Line Red "  ผิด    $k ต้องเป็น sql (ตอนนี้ '$($web[$k])' = อ่าน/เขียน Google Sheet ซึ่งหยุดอัปเดตแล้ว)" }
}
if ($web['AUTH_API_KEY']) { Line Yellow '  เตือน  มี AUTH_API_KEY — ต้องตรงกับฝั่ง NaraiAPI ไม่งั้นหน้าจัดการผู้ใช้พัง (ลบออกได้ จะใช้ QCRD_WRITE_KEY แทน)' }
if (-not $web['BRANCH_FEED_KEY']) { Line Yellow '  เตือน  ไม่มี BRANCH_FEED_KEY — /api/branch-feed ปิดอยู่ (narai-storefct ดึงทะเบียนสาขาไม่ได้)' }
if (-not $web['GEMINI_API_KEY'] -or $web['GEMINI_API_KEY'] -eq '[SENSITIVE]') { Line Yellow '  เตือน  ไม่มี GEMINI_API_KEY — เมนู AI NARAI ใช้ไม่ได้' }

# กุญแจเขียน: เว็บส่ง SHEETS_WRITE_KEY||QCRD_WRITE_KEY (หน้าสแกน/ค่าใช้จ่าย/สาขา)
# และ AUTH_API_KEY||QCRD_WRITE_KEY (ผู้ใช้) ไปเทียบกับ env ของ service NaraiAPI
$nssm = @('C:\tools\nssm.exe', 'C:\narai-api\nssm.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($nssm) {
  $api = @{}
  foreach ($raw in @(& $nssm get $ApiService AppEnvironmentExtra)) {
    $s = "$raw" -replace "`0", ''
    if ($s -match '^([A-Z0-9_]+)=(.*)$') { $api[$Matches[1]] = $Matches[2] }
  }
  $pairs = @(
    @('ผู้ใช้/สิทธิ์', ($web['AUTH_API_KEY'], $web['QCRD_WRITE_KEY'] | Where-Object { $_ } | Select-Object -First 1), ($api['AUTH_API_KEY'], $api['QCRD_WRITE_KEY'] | Where-Object { $_ } | Select-Object -First 1)),
    @('QC/RD บันทึก', $web['QCRD_WRITE_KEY'], $api['QCRD_WRITE_KEY']),
    @('สแกน/ค่าใช้จ่าย/สาขา บันทึก', ($web['SHEETS_WRITE_KEY'], $web['QCRD_WRITE_KEY'] | Where-Object { $_ } | Select-Object -First 1), ($api['SHEETS_WRITE_KEY'], $api['QCRD_WRITE_KEY'] | Where-Object { $_ } | Select-Object -First 1))
  )
  foreach ($p in $pairs) {
    if ($p[1] -and $p[1] -eq $p[2]) { Line Green "  ผ่าน   กุญแจ $($p[0]) ตรงกับ $ApiService" }
    else { Line Red "  ผิด    กุญแจ $($p[0]) ไม่ตรงกับ $ApiService — บันทึกจะขึ้น 'x-api-key ไม่ถูกต้อง'" }
  }
} else { Line Yellow '  ข้าม   ไม่เจอ nssm.exe — เทียบกุญแจกับ NaraiAPI ไม่ได้' }

# ───────────────────────── 2) ทุกหน้า ─────────────────────────
Line Cyan "`n== 2) เรียกทุกหน้า (อ่านอย่างเดียว) $BaseUrl · วันที่ $Day · สาขา $Branch =="
$user = Read-Host 'ชื่อผู้ใช้ (ผู้ดูแลระบบ)'
$pwSecure = Read-Host 'รหัสผ่าน' -AsSecureString
$pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwSecure))

function Call($method, $path, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = @{ Uri = "$BaseUrl$path"; Method = $method; UseBasicParsing = $true; TimeoutSec = 90 }
  if ($script:session) { $p.WebSession = $script:session } else { $p.SessionVariable = 'newSession' }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $p.ContentType = 'application/json; charset=utf-8' }
  try {
    $r = Invoke-WebRequest @p
    if (-not $script:session) { $script:session = $newSession }
    $code = [int]$r.StatusCode
    $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ ok = $false; code = 0; ms = $sw.ElapsedMilliseconds; msg = $_.Exception.Message } }
    $code = [int]$resp.StatusCode
    $text = (New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd()
  }
  $json = $null; try { $json = $text | ConvertFrom-Json } catch {}
  $msg = ''
  if ($json) { $msg = @($json.error, $json.message, $json.hint) | Where-Object { $_ -and "$_" -ne 'True' } | Select-Object -First 2 }
  if (-not $json -and $code -ge 400) { $msg = ($text -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim() }
  $ok = $code -lt 400 -and -not ($json -and ($json.status -eq 'error' -or ($json.error -and $json.error -isnot [bool])))
  $note = ''
  if ($json) {
    if ($json.warning) { $note += " ⚠ $($json.warning)" }
    if ($json.source -and "$($json.source)" -match 'sheet') { $note += " ⚠ อ่านจากชีท (source=$($json.source))" }
    $n = $null
    if ($json.data -is [array]) { $n = $json.data.Count } elseif ($json -is [array]) { $n = $json.Count } elseif ($json.count -ne $null) { $n = $json.count }
    if ($n -ne $null) { $note = " ($n แถว)$note" }
  }
  @{ ok = $ok; code = $code; ms = $sw.ElapsedMilliseconds; msg = ($msg -join ' — '); note = $note }
}

$login = Call POST '/api/auth' @{ action = 'login'; username = $user; password = $pw }
$pw = $null
if (-not $login.ok) { Line Red "ล็อกอินไม่ผ่าน (HTTP $($login.code)) $($login.msg)"; exit 1 }
Line Green "ล็อกอินผ่าน`n"

$d = $Day; $b = [uri]::EscapeDataString($Branch)
$checks = @(
  @('ระบบ › จัดการผู้ใช้', 'GET', '/api/users'),
  @('สาขา (dropdown ทุกหน้า)', 'GET', '/api/branches'),
  @('ACC › รายงานยอดการขาย', 'GET', "/api/sales?start=$d&end=$d"),
  @('ACC › รายละเอียดรายการ', 'GET', "/api/detail?start=$d&end=$d"),
  @('ACC › POS ล่าสุด', 'GET', '/api/pos-latest?days=2'),
  @('ACC › ค้นหาสมาชิก', 'GET', '/api/members'),
  @('ACC › ค่าใช้จ่ายอื่นๆ', 'POST', '/api/expense-gas', @{ action = 'getExpenses' }),
  @('ACC › รายงานจากซัพหน้าสาขา', 'GET', "/api/sup-cost?start=$d&end=$d"),
  @('STOCK › ยอดรวมทุกสาขา', 'GET', '/api/stock-read?action=getStockTotal'),
  @('STOCK › ปิดรอบเดือน', 'GET', '/api/stock-month-end?view=summary'),
  @('STOCK › ยอดปิดรอบสาขา', 'GET', "/api/stock-closing?branch=$b"),
  @('STOCK › ยอดใช้ตาม BOM', 'GET', "/api/usage-bom?branch=$b&startDate=$d&endDate=$d"),
  @('STOCK › ยอดใช้รายโต๊ะ', 'GET', "/api/usagebytable?branch=$b&startDate=$d&endDate=$d"),
  @('HR › รายชื่อพนักงาน', 'GET', '/api/stock-gas'),
  @('HR › ดูสแกนหน้า', 'GET', "/api/attendance?start=$d&end=$d&branch=$b"),
  @('HR › เวลาที่แก้ไว้', 'GET', "/api/attendance-edit?start=$d&end=$d"),
  @('HR › ตารางงาน', 'GET', "/api/hr-schedule?start=$d&end=$d&branch=$b"),
  @('HR › ยูนิฟอร์ม', 'GET', '/api/uniform-branch'),
  @('HR › login สาขา', 'GET', '/api/branch-users'),
  @('QC/RD › เมนู', 'GET', '/api/qcrd?sheet=menu'),
  @('QC/RD › สูตร BOM', 'GET', '/api/qcrd?sheet=bom'),
  @('QC/RD › วัตถุดิบ', 'GET', '/api/qcrd?sheet=item'),
  @('QC/RD › หมวดเมนู', 'GET', '/api/menugroup'),
  @('QC/RD › ต้นทุน', 'GET', '/api/cost'),
  @('QC/RD › วัตถุดิบ→เมนู', 'GET', '/api/recipe'),
  @('QC/RD › สูตร POS', 'GET', '/api/rcp'),
  @('QC/RD › รายงานการผลิต', 'GET', '/api/kitchen-report?menus=1'),
  @('QC/RD › แหล่งเมนู', 'GET', '/api/qcrd-menu-source?limit=1'),
  @('QC/RD › แหล่งวัตถุดิบ', 'GET', '/api/qcrd-item-source?limit=1'),
  @('จัดซื้อ › แพลนสินค้า', 'GET', '/api/plan'),
  @('จัดซื้อ › รหัสหมวดแพลน', 'GET', '/api/plan-items'),
  @('จัดซื้อ › ใบสั่ง (MySQL)', 'GET', "/api/orderd?branch=$b&startDate=$d&endDate=$d"),
  @('จัดซื้อ › การเบิก (MySQL)', 'GET', "/api/withdrawals?branch=$b&startDate=$d&endDate=$d"),
  @('จัดซื้อ › เบิกของสาขา', 'GET', '/api/branch-requisition'),
  @('จัดซื้อ › ออเดอร์นอกเครือ', 'GET', '/api/extra-orders'),
  @('เฟรนไชส์ › ต่อฐาน', 'GET', '/api/franchise?view=diag')
)

$fail = 0
foreach ($c in $checks) {
  $r = Call $c[1] $c[2] $c[3]
  $label = $c[0].PadRight(28)
  if ($r.ok) { Line Green ("  ผ่าน  {0} {1,6} ms{2}" -f $label, $r.ms, $r.note) }
  else { $fail++; Line Red ("  พัง   {0} HTTP {1} · {2}" -f $label, $r.code, $r.msg) }
}

Line Cyan "`n== สรุป: พัง $fail จาก $($checks.Count) หน้า =="
Line Gray  'ข้อความ error เต็ม ๆ อยู่ใน log ของ service: nssm get NaraiOfficeWeb AppStderr'
