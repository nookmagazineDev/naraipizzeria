@echo off
chcp 65001 >nul
setlocal
rem ════════════════════════════════════════════════════════════
rem  update-office.bat — อัปเดตเว็บ office ให้เป็นเวอร์ชันล่าสุดจาก GitHub คลิกเดียวจบ
rem
rem    git pull → (npm ci ถ้า package เปลี่ยน) → npm run build → รีสตาร์ต service
rem
rem  ต้องคลิกขวา "Run as administrator" (สั่งหยุด/เริ่ม service ต้องใช้สิทธิ์แอดมิน)
rem  build ไม่ผ่าน = ย้อนโค้ดกลับไปเวอร์ชันก่อนหน้า build ใหม่ แล้วเปิด service ให้เอง
rem  เว็บจะปิดระหว่าง build ราว 1-3 นาที
rem
rem  ⚠️ ไฟล์นี้ต้องเป็น UTF-8 ไม่มี BOM + ขึ้นบรรทัดแบบ CRLF (ดู .gitattributes)
rem ════════════════════════════════════════════════════════════
rem git pull / git reset อาจเขียนทับไฟล์นี้ระหว่างที่ cmd ยังอ่านอยู่ (cmd อ่าน .bat ทีละบรรทัดจากดิสก์)
rem จึงคัดลอกตัวเองไปไว้ใน TEMP แล้วรันตัวนั้นแทน — ส่งโฟลเดอร์รีโปไปเป็นอาร์กิวเมนต์ที่ 2
if /i "%~1"=="--run" goto :start
copy /y "%~f0" "%TEMP%\narai-update-office.bat" >nul
"%TEMP%\narai-update-office.bat" --run "%~dp0."

:start
set "SERVICE=NaraiOfficeWeb"
set "NSSM=C:\tools\nssm.exe"
title อัปเดตเว็บ office
cd /d "%~2"

net session >nul 2>&1
if errorlevel 1 goto :need_admin
if not exist "%NSSM%" goto :no_nssm

rem ── ไฟล์ที่ git ติดตามอยู่ถูกแก้ค้างบนเครื่องนี้ = หยุด ไม่งั้น pull จะทับหรือพัง ──
set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain -uno') do set "DIRTY=1"
if defined DIRTY goto :dirty

for /f %%i in ('git rev-parse HEAD') do set "OLD=%%i"
echo.
echo === 1/4 ดึงโค้ดล่าสุดจาก GitHub ===
git pull --ff-only
if errorlevel 1 goto :pull_failed
for /f %%i in ('git rev-parse HEAD') do set "NEW=%%i"

if not "%OLD%"=="%NEW%" goto :changed
echo.
echo ไม่มีอะไรใหม่บน GitHub — เว็บเป็นเวอร์ชันล่าสุดอยู่แล้ว
choice /c YN /m "จะ build และรีสตาร์ตใหม่อยู่ดีไหม"
if errorlevel 2 goto :end_ok
goto :build

:changed
echo.
echo สิ่งที่อัปเดตเข้ามา:
git --no-pager log --oneline %OLD%..%NEW%
git diff --quiet %OLD% %NEW% -- host-server
if errorlevel 1 echo [หมายเหตุ] มีไฟล์ใน host-server เปลี่ยน — service NaraiAPI ไม่ได้อัปเดตด้วยไฟล์นี้ ต้องอัปเดตแยก

:build
set "DEPS="
if not "%OLD%"=="%NEW%" git diff --quiet %OLD% %NEW% -- package.json package-lock.json
if not "%OLD%"=="%NEW%" if errorlevel 1 set "DEPS=1"

echo.
echo === 2/4 หยุดเว็บ %SERVICE% ===
"%NSSM%" stop %SERVICE%

if not defined DEPS goto :do_build
echo.
echo === ติดตั้ง package ใหม่ npm ci ===
call npm ci --no-audit --no-fund
if errorlevel 1 goto :rollback

:do_build
echo.
echo === 3/4 build ===
call npm run build
if errorlevel 1 goto :rollback

echo.
echo === 4/4 เปิดเว็บ %SERVICE% ===
"%NSSM%" start %SERVICE%
echo.
echo เสร็จแล้ว — รอสัก 10 วินาที แล้วกด F5 ที่หน้าเว็บ
goto :end_ok

:rollback
echo.
echo !!! build ไม่ผ่าน — ย้อนกลับไปเวอร์ชันก่อนหน้า %OLD%
echo !!! เลื่อนขึ้นไปดูข้อความ error แล้วแคปส่งให้คนดูแลระบบ
git reset --hard %OLD%
if defined DEPS call npm ci --no-audit --no-fund
call npm run build
"%NSSM%" start %SERVICE%
echo.
echo เปิดเว็บกลับมาด้วยเวอร์ชันเดิมแล้ว
goto :end_fail

:need_admin
echo ต้องคลิกขวาที่ไฟล์นี้ แล้วเลือก "Run as administrator"
goto :end_fail

:no_nssm
echo ไม่เจอ %NSSM% — แก้บรรทัด set "NSSM=..." ในไฟล์นี้ให้ชี้ไปที่ nssm.exe
goto :end_fail

:dirty
echo มีไฟล์ถูกแก้ค้างอยู่บนเครื่องนี้ จึงยังไม่อัปเดต:
git --no-pager status --short -uno
echo ส่งรายชื่อไฟล์ข้างบนให้คนดูแลระบบดูก่อน
goto :end_fail

:pull_failed
echo ดึงโค้ดจาก GitHub ไม่สำเร็จ — ดูข้อความ error ข้างบน เว็บยังทำงานเวอร์ชันเดิมอยู่
goto :end_fail

:end_ok
echo.
pause
exit /b 0

:end_fail
echo.
pause
exit /b 1
