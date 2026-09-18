# คำสั่งที่ต้องรันที่เครื่องออฟฟิศ — ทะเบียนสาขากลาง + login สาขา

เปิด **PowerShell** ที่เครื่องออฟฟิศ (เครื่องที่มี SQL Server) แล้วทำตามลำดับ
พื้นหลังและเหตุผลทั้งหมดอยู่ใน `docs/branch-hub.md`

> ⚠️ ทำตามลำดับ ห้ามข้าม — ขั้นที่ 5 ต้องทำนอกเวลาขาย

---

## ขั้น 0 — หาโฟลเดอร์ของทั้งสองโปรแกรม

```powershell
# naraipizzeria/host-server — หาจากโปรเซสที่ถือพอร์ต 14365 อยู่
Get-NetTCPConnection -LocalPort 14365 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$_").CommandLine }

# Narai-branch/office-server — รันเป็น Windows Service ผ่าน NSSM
C:\tools\nssm.exe get NaraiUsageAPI AppDirectory
```

จดสองพาธไว้ แล้วตั้งเป็นตัวแปรให้ใช้ต่อได้ทั้งหน้า (แก้ให้ตรงกับของจริง):

```powershell
$Pizza  = 'C:\narai\naraipizzeria'      # โฟลเดอร์รีโป naraipizzeria (ตัวที่มีโฟลเดอร์ host-server)
$Branch = 'C:\narai\Narai-branch'       # โฟลเดอร์รีโป Narai-branch (ตัวที่มีโฟลเดอร์ office-server)
```

---

## ขั้น 1 — ดึงโค้ดใหม่ทั้งสองรีโป

```powershell
cd $Pizza
git pull origin main

cd $Branch
git pull origin main
```

> โค้ดที่รันอยู่ถือเวอร์ชันตอนที่มันเริ่ม — `git pull` เฉย ๆ ยังไม่มีผลจนกว่าจะรีสตาร์ท (ขั้น 3)

---

## ขั้น 2 — รัน SQL สามไฟล์

```powershell
cd $Pizza

sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P '<รหัส sa>' -i docs\schema-hr-branch.sql
sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P '<รหัส sa>' -i docs\migrate-branch-hub.sql
sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P '<รหัส sa>' -i docs\grant-hr-user.sql
```

`-f 65001` จำเป็น ห้ามตัดทิ้ง — ไฟล์เป็น UTF-8 ถ้ารันด้วย codepage ผิด คำว่า `N'ใช้งาน'`
จะถูกเขียนลงฐานเป็นตัวอ่านไม่ออก (เคยเกิดมาแล้ว)

**ไฟล์ทั้งสามรันซ้ำได้ ไม่ทับข้อมูลเดิม**

### ไม่มี sqlcmd บนเครื่อง

ใช้ตัวรันที่มากับรีโปแทน (ใช้ค่าเชื่อมต่อจาก `host-server\db.env.ps1`):

```powershell
cd $Pizza
. .\host-server\db.env.ps1

node scripts\run-sql.mjs docs\schema-hr-branch.sql
node scripts\run-sql.mjs docs\migrate-branch-hub.sql
node scripts\run-sql.mjs docs\grant-hr-user.sql
```

⚠️ **ดูบรรทัดแรกที่มันพิมพ์ออกมาก่อน** — ต้องเป็น `… → localhost\SQLEXPRESS/InventoryNarai`
ถ้าชี้ไปเครื่องหรือฐานอื่น ให้หยุดแล้วตั้ง `$env:QCRD_DB_SERVER` / `$env:QCRD_DB_NAME` ให้ถูกก่อน

ขึ้นว่าไม่พบ package `mssql` ให้ `npm install` ในโฟลเดอร์รีโปก่อน

### ผลที่ควรเห็น

```
ขั้นที่ 1: เพิ่ม STS / ZK3 เรียบร้อย
ขั้นที่ 2: ปิดสาขาไปแล้ว 3 สาขา
ขั้นที่ 3: ย้ายค่าเป้ามาแล้ว N สาขา
ขั้นที่ 4: แก้ outlet ของ HPS เป็น 902 แล้ว
```

ขึ้นว่า "ข้าม (รันไปแล้ว)" = เคยรันไปแล้ว ไม่ใช่ error

---

## ขั้น 3 — รีสตาร์ททั้งสองโปรแกรม

```powershell
cd $Pizza\host-server
powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart -NoTunnel

Restart-Service NaraiUsageAPI
```

> `-NoTunnel` ใช้เมื่อเครื่องนี้มี tunnel ถาวรอยู่แล้ว (URL คงที่ที่ตั้งไว้บน Vercel)
> ถ้าไม่แน่ใจ ใส่ไว้ก่อน — สคริปต์ตรวจให้เองอยู่แล้วว่ามี tunnel รันอยู่ไหม

---

## ขั้น 4 — ตรวจว่าโค้ดใหม่ถูกโหลดจริง

```powershell
curl.exe http://localhost:14365/sheets/ping
curl.exe http://localhost:14365/sheets/branch-alias
curl.exe http://localhost:14365/sheets/branch-user
Get-Service NaraiUsageAPI
```

`/sheets/branch-alias` กับ `/sheets/branch-user` เป็นเส้นใหม่ของรอบนี้ —
**ขึ้น 404 = ยังรีสตาร์ทไม่สำเร็จ** (ย้อนกลับไปขั้น 3) ไม่ใช่ปัญหาฐานข้อมูล

แล้วเปิดหน้าเว็บ `HR → จัดการสาขา` ดูว่าการ์ด "รหัสพ้อง" ขึ้นรายการ ZJP/ZIP
กับหน้า `HR → login สาขา` ขึ้นรายชื่อบัญชี

---

## ขั้น 5 — ให้ระบบตารางงานอ่านทะเบียนกลาง  ⏰ นอกเวลาขาย

ระหว่างสลับ หน้าลงตารางงานจะอ่านรายชื่อสาขาไม่ได้ชั่วขณะ

```powershell
cd $Branch
sqlcmd -f 65001 -S localhost -E -i docs\branch-hub-view.sql
```

ตรวจผลด้วยคำสั่งท้ายไฟล์นั้น — **อย่าข้ามข้อที่ทดสอบด้วย `EXECUTE AS USER = 'narai_web'`**
เพราะสิทธิ์ข้ามฐานเป็นจุดที่ทดสอบด้วย `sa` แล้วผ่านแต่แอปจริงพัง

ถอยกลับ (ถ้ามีปัญหา):

```powershell
sqlcmd -S localhost -E -Q "USE narai_hr; DROP VIEW dbo.hr_branch; EXEC sys.sp_rename N'dbo.hr_branch_legacy', N'hr_branch';"
```

---

## ขั้น 6 — ย้าย login สาขาจากชีท (ทำทีหลังได้)

ไม่ทำข้อนี้ = ตั้งรหัสใหม่จากหน้าเว็บแล้วอาจถูกย้อนกลับเงียบ ๆ (เหตุผลอยู่ใน `docs/branch-hub.md` หัวข้อ 9)

1. เปิดชีท `User` → ไฟล์ → ดาวน์โหลด → **ค่าที่คั่นด้วยจุลภาค (.csv)** → เซฟลงเครื่องออฟฟิศ

2. ดูก่อนว่าจะเกิดอะไร (ยังไม่เขียนฐาน):

```powershell
cd $Pizza
. .\host-server\db.env.ps1
node scripts\import-hr-users.mjs C:\temp\users.csv
```

3. พอใจแล้วค่อยเขียนจริง:

```powershell
node scripts\import-hr-users.mjs C:\temp\users.csv --commit
```

4. เทียบที่หน้า `HR → login สาขา` ว่าบัญชีครบทุกสาขาที่ยังเปิดอยู่

5. ปิดทางถอยไปชีท — แก้ `.env` ของ office-server แล้วรีสตาร์ท:

```powershell
Add-Content -Path "$Branch\office-server\.env" -Value "`nSHEET_LOGIN_URL=off"
Restart-Service NaraiUsageAPI
```

6. **ลบไฟล์ CSV ทิ้ง** — มีรหัสผ่านของทุกสาขาเป็นข้อความล้วน:

```powershell
Remove-Item C:\temp\users.csv -Force
```

---

## สรุปคำสั่งทั้งหมด (ขั้น 1-4 รวดเดียว)

แก้สองบรรทัดแรกให้ตรงกับเครื่องก่อน แล้ววางทีเดียวได้

```powershell
$Pizza  = 'C:\narai\naraipizzeria'
$Branch = 'C:\narai\Narai-branch'
$SaPw   = '<รหัส sa>'

cd $Pizza;  git pull origin main
cd $Branch; git pull origin main

cd $Pizza
sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P $SaPw -i docs\schema-hr-branch.sql
sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P $SaPw -i docs\migrate-branch-hub.sql
sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P $SaPw -i docs\grant-hr-user.sql

cd $Pizza\host-server
powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart -NoTunnel
Restart-Service NaraiUsageAPI

curl.exe http://localhost:14365/sheets/branch-alias
curl.exe http://localhost:14365/sheets/branch-user
```

---

## ที่เหลือทำบน Vercel (ไม่ใช่ที่เครื่องออฟฟิศ)

| โปรเจค | ตัวแปร | ค่า |
|---|---|---|
| naraipizzeria | `BRANCH_FEED_KEY` | สุ่มมาสัก 32 ตัว |
| narai-storefct | `BRANCH_HUB_BASE` | URL ของ naraipizzeria |
| narai-storefct | `BRANCH_FEED_KEY` | ตัวเดียวกับข้างบน |

ตั้งแล้ว Redeploy ทั้งสองโปรเจค

สุ่มกุญแจด้วย PowerShell:

```powershell
-join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

และอย่าลืม **deploy Apps Script ใหม่** (เอา `Narai-branch/apps-script.js` ไปวางแทนของเดิม)
ไม่งั้น HPS จะยังใช้ outlet 109 ที่ผิดอยู่ที่เดียว
