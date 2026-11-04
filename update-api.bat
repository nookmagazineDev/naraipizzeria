@echo off
chcp 65001 >nul
setlocal
rem ════════════════════════════════════════════════════════════
rem  update-api.bat — อัปเดต host-server (service NaraiAPI) คลิกเดียวจบ
rem
rem    git pull → (npm install ใน host-server ถ้า package.json เปลี่ยน) → รีสตาร์ต NaraiAPI → เช็กว่าตอบ
rem
rem  วางไว้ในโฟลเดอร์รีโปที่ NaraiAPI รันอยู่จริง (nssm get NaraiAPI AppDirectory = <รีโป>\host-server)
rem  host-server โหลดไฟล์ใน lib\ ของรีโปนี้ด้วย ไม่ใช่แค่ host-server\
rem  ต้องคลิกขวา "Run as administrator"
rem  รีสตาร์ตแล้วไม่ตอบ = ย้อนโค้ดกลับเวอร์ชันก่อนหน้าแล้วรีสตาร์ตอีกรอบ
rem  ระหว่างรีสตาร์ต ทุกหน้าของเว็บดึงข้อมูลไม่ได้ราว 5-10 วินาที
rem
rem  ⚠️ ไฟล์นี้ต้องเป็น UTF-8 ไม่มี BOM + ขึ้นบรรทัดแบบ CRLF (ดู .gitattributes)
rem ════════════════════════════════════════════════════════════
rem git pull / git reset อาจเขียนทับไฟล์นี้ระหว่างที่ cmd ยังอ่านอยู่ — รันจากสำเนาใน TEMP แทน
if /i "%~1"=="--run" goto :start
copy /y "%~f0" "%TEMP%\narai-update-api.bat" >nul
"%TEMP%\narai-update-api.bat" --run "%~dp0."

:start
set "SERVICE=NaraiAPI"
set "PORT=14365"
set "NSSM=C:\tools\nssm.exe"
if not exist "%NSSM%" set "NSSM=C:\narai-api\nssm.exe"
title อัปเดต host-server NaraiAPI
cd /d "%~2"

net session >nul 2>&1
if errorlevel 1 goto :need_admin
if not exist "%NSSM%" goto :no_nssm
if not exist "host-server\server.js" goto :wrong_dir

echo %SERVICE% รันโค้ดจากโฟลเดอร์:
"%NSSM%" get %SERVICE% AppDirectory
echo ไฟล์นี้อยู่ที่: %CD%
echo ถ้าสองบรรทัดบนเป็นคนละโฟลเดอร์ ให้ปิดหน้าต่างนี้ แล้วไปรันไฟล์ในโฟลเดอร์ที่ %SERVICE% ใช้
echo.

rem ── ไฟล์ที่ git ติดตามถูกแก้/ลบค้าง = หยุด (ไฟล์ใหม่ที่เพิ่ง add ไว้ไม่นับ pull ผ่านได้) ──
set "DIRTY="
for /f "delims=" %%i in ('git diff --name-only --diff-filter=MD HEAD') do set "DIRTY=1"
if defined DIRTY goto :dirty

for /f %%i in ('git rev-parse HEAD') do set "OLD=%%i"
echo === 1/3 ดึงโค้ดล่าสุดจาก GitHub ===
git pull --ff-only
if errorlevel 1 goto :pull_failed
for /f %%i in ('git rev-parse HEAD') do set "NEW=%%i"

if not "%OLD%"=="%NEW%" goto :changed
echo.
echo ไม่มีอะไรใหม่บน GitHub
choice /c YN /m "จะรีสตาร์ต %SERVICE% อยู่ดีไหม (ทำครั้งแรกหลัง git pull ด้วยมือ ให้ตอบ Y)"
if errorlevel 2 goto :end_ok
goto :restart

:changed
echo.
echo สิ่งที่อัปเดตเข้ามา (เฉพาะที่ host-server ใช้):
git --no-pager log --oneline %OLD%..%NEW% -- host-server lib
git diff --quiet %OLD% %NEW% -- host-server/package.json
if not errorlevel 1 goto :restart
echo.
echo === ติดตั้ง package ของ host-server ใหม่ ===
"%NSSM%" stop %SERVICE%
pushd host-server
call npm install --no-audit --no-fund
set "NPMERR=%errorlevel%"
popd
if not "%NPMERR%"=="0" goto :rollback

:restart
echo.
echo === 2/3 รีสตาร์ต %SERVICE% ===
"%NSSM%" restart %SERVICE%
call :wait_up
if errorlevel 1 goto :rollback

echo.
echo === 3/3 เช็กเวอร์ชัน ===
powershell -NoProfile -Command "[Console]::OutputEncoding = [Text.Encoding]::UTF8; try { $l = (Invoke-RestMethod 'http://localhost:%PORT%/sheets/month-end-summary' -TimeoutSec 60).data.layout; if ($l.cycleCutoffDay -ne $null) { 'ปิดรอบเดือน: host-server คิดรอบเดือนเองแล้ว — แถบเตือนสีเหลืองบนหน้าเว็บจะหายไป' } else { 'ปิดรอบเดือน: ยังเป็นเวอร์ชันเก่า (ไม่มี cycleCutoffDay)' } } catch { 'เช็กปิดรอบเดือนไม่ได้: ' + $_.Exception.Message }"
echo.
echo เสร็จแล้ว — %SERVICE% ทำงานด้วยโค้ดล่าสุด
goto :end_ok

rem ── รอให้ node ตอบที่พอร์ต (สถานะอะไรก็ได้ = process ขึ้นแล้ว) สูงสุดราว 30 วินาที ──
:wait_up
powershell -NoProfile -Command "for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 3; try { Invoke-WebRequest 'http://localhost:%PORT%/sheets/ping' -UseBasicParsing -TimeoutSec 10 | Out-Null; exit 0 } catch { if ($_.Exception.Response) { exit 0 } } }; exit 1"
if errorlevel 1 (
  echo %SERVICE% ไม่ตอบที่พอร์ต %PORT%
  exit /b 1
)
echo %SERVICE% ตอบแล้ว
exit /b 0

:rollback
echo.
if "%OLD%"=="%NEW%" goto :rollback_same
echo !!! อัปเดตไม่ผ่าน — ย้อนกลับไปเวอร์ชันก่อนหน้า %OLD%
echo !!! เลื่อนขึ้นไปดูข้อความ error แล้วแคปส่งให้คนดูแลระบบ
git reset --keep %OLD%
pushd host-server
call npm install --no-audit --no-fund
popd
"%NSSM%" restart %SERVICE%
call :wait_up
goto :end_fail

:rollback_same
echo !!! %SERVICE% ไม่ตอบหลังรีสตาร์ต ทั้งที่โค้ดไม่ได้เปลี่ยน — ดู log ของ service:
"%NSSM%" get %SERVICE% AppStderr
goto :end_fail

:need_admin
echo ต้องคลิกขวาที่ไฟล์นี้ แล้วเลือก "Run as administrator"
goto :end_fail

:no_nssm
echo ไม่เจอ nssm.exe — แก้บรรทัด set "NSSM=..." ในไฟล์นี้
goto :end_fail

:wrong_dir
echo โฟลเดอร์นี้ไม่มี host-server\server.js — วางไฟล์นี้ไว้ในโฟลเดอร์รีโปที่ %SERVICE% ใช้
goto :end_fail

:dirty
echo มีไฟล์ถูกแก้ค้างอยู่บนเครื่องนี้ จึงยังไม่อัปเดต:
git --no-pager diff --name-status --diff-filter=MD HEAD
echo ส่งรายชื่อไฟล์ข้างบนให้คนดูแลระบบดูก่อน
goto :end_fail

:pull_failed
echo ดึงโค้ดจาก GitHub ไม่สำเร็จ — ดูข้อความ error ข้างบน %SERVICE% ยังทำงานเวอร์ชันเดิมอยู่
goto :end_fail

:end_ok
echo.
pause
exit /b 0

:end_fail
echo.
pause
exit /b 1
