# Narai API (host server)

API ตัวกลางที่รันบน **เครื่อง Windows Server เครื่องเดียวกับ SQL Server** (`NaraiPos`)
แล้วเปิดออกเน็ตผ่าน **ngrok** ให้ Dashboard (Vercel) เรียกใช้

Dashboard เรียกผ่าน proxy ฝั่ง Next.js:
- `pages/api/sales.js`  → `/cpaidbetweendate`
- `pages/api/detail.js` → `/ctranbetweendate`
- `pages/api/attendance.js` (หน้า "ดูสแกนหน้า") → `/zk/transactions`, `/zk/employees`
- `pages/api/ai-chat.js` (AI NARAI) → `/zk/transactions`, `/zk/employees`

> หมายเหตุ: `/usagemenu`, `/usagebytable` (port 8787) ยังใช้เซิร์ฟเวอร์เดิม `storenarai.dyndns.tv` ไม่เกี่ยวกับไฟล์นี้

## ติดตั้ง

```bash
npm init -y
npm install express mssql cors compression
node server.js
```

### ⚠️ ตั้งรหัสผ่าน SQL ผ่าน env (ห้ามฝังในไฟล์ — repo เป็น public)

ก่อนรัน ตั้ง environment variable บนเครื่องโฮสต์:

```cmd
set DB_SERVER=localhost
set DB_NAME=NaraiPos
set DB_USER=SA
set DB_PASSWORD=ใส่รหัสจริงตรงนี้
node server.js
```

> 🔐 รหัสผ่านที่หลุดไป git แล้วต้อง **เปลี่ยนรหัส SQL login ใหม่ทันที** (ดูหัวข้อด้านล่าง)

เปิด ngrok ชี้ที่ port 14365:

```bash
ngrok http 14365
```

URL ที่ได้ ให้ตั้งเป็น env บน Vercel:

```
STORE_API_BASE = https://<ชื่อ>.ngrok-free.dev
```

(ถ้าไม่ตั้ง จะ default เป็น URL ngrok ปัจจุบันที่ฝังไว้ในโค้ด)

## ⚠️ ก่อนใช้งานจริง: หาตารางบิลให้ถูก

`/cpaidbetweendate` ตอนนี้ตั้งค่าเดาไว้ที่:

```js
const PAID_TABLE = 'dbo.Cpaids';
const PAID_DATE_COL = 'PostTime';
```

ใช้ endpoint ช่วย debug หาชื่อจริง:

| เรียก | ได้อะไร |
|---|---|
| `/tables` | รายชื่อตารางทั้งหมด → หาตารางบิล |
| `/columns?table=Cpaids` | คอลัมน์ของตารางบิล |
| `/sample?table=Cpaids` | ตัวอย่าง 1 แถว (ดูว่ามี checkID, billTotal, paidType, cash, credit, qr...) |

แล้วแก้ `PAID_TABLE` / `PAID_DATE_COL` ให้ตรง

## ZKBio Time 9 (เครื่องสแกนหน้า/นิ้ว)

server.js ต่อฐานข้อมูลของ ZKBio Time ได้อีกตัว (แยกจาก `NaraiPos`) เพื่อให้
AI NARAI ตอบคำถามเวลาสแกนเข้า-ออกงานได้

ค่า default ตรงกับเครื่องที่ร้านแล้ว (instance `localhost\SQLEXPRESS`, database `ZKBio9`)
**ปกติจึงไม่ต้องตั้ง env อะไรเพิ่ม** — ตั้งใน `db.env.ps1` เฉพาะเมื่อค่าต่างจากนี้:

```powershell
$env:ZK_DB_SERVER   = 'localhost\SQLEXPRESS'   # instance ที่ ZKBio ใช้
$env:ZK_DB_NAME     = 'ZKBio9'                 # ชื่อ DB ของ ZKBio Time
#$env:ZK_DB_USER     = 'administrator'         # ไม่ตั้ง = ใช้ DB_USER/DB_PASSWORD เดิม
#$env:ZK_DB_PASSWORD = '...'
```

ข้อควรรู้:

- **named instance (`localhost\SQLEXPRESS`) ต้องเปิด service "SQL Server Browser"**
  บนเครื่อง ไม่งั้น node หา instance ไม่เจอ (เปิดใน SQL Server Configuration Manager)
- การต่อ ZKBio เป็นแบบ lazy — ถ้ายังไม่ตั้งค่าหรือต่อไม่ได้ endpoint `/zk/*` จะคืน error
  แต่ API ยอดขายหลักทำงานปกติ
- เช็กว่าต่อได้: เปิด `http://localhost:14365/zk/ping`
- **หน้า "ดูสแกนหน้า" บน Dashboard ดึงผ่าน `/zk/transactions` ของเครื่องนี้**
  ถ้าหน้าเว็บขึ้น "ต่อ host API ... ไม่ได้" แปลว่าเครื่องนี้ปิด / `node server.js` ไม่ได้รัน /
  tunnel หลุด — ไม่ต้องไปเปิดพอร์ต SQL ออกอินเทอร์เน็ต (ไม่ปลอดภัย และไม่ใช่ทางที่โค้ดใช้)
- ถ้าชื่อตารางไม่ตรงกับ default (`iclock_transaction`, `personnel_employee`,
  `personnel_department`) ให้ดูชื่อจริงจาก `/zk/tables` แล้วตั้ง env
  `ZK_TRANS_TABLE` / `ZK_EMP_TABLE` / `ZK_DEPT_TABLE`

## QC/RD (เมนู · สูตร BOM · วัตถุดิบ) — ฐาน InventoryNarai

`server.js` ต่อฐานข้อมูลตัวที่สาม (`InventoryNarai` บน `localhost\SQLEXPRESS` — ฐานเดียวกับหน้านับสต๊อก)
เพื่อให้หน้า QC/RD บน Dashboard เลิกอ่าน/เขียน Google Sheets

ตารางและขั้นตอนย้ายข้อมูลอยู่ใน [`docs/qcrd-sql-migration.md`](../docs/qcrd-sql-migration.md)
ตรรกะทั้งหมดอยู่ใน `host-server/qcrd-db.js` (ตัวที่มาแทน `qcrd-apps-script.gs`)

```powershell
$env:QCRD_DB_SERVER   = 'localhost\SQLEXPRESS'   # ไม่ตั้ง = ใช้ DB_SERVER
$env:QCRD_DB_NAME     = 'InventoryNarai'
$env:QCRD_DB_USER     = '<user>'                 # ไม่ตั้ง = ใช้ DB_USER/DB_PASSWORD เดิม
$env:QCRD_DB_PASSWORD = '<รหัสผ่าน>'
$env:QCRD_WRITE_KEY   = '<สุ่มข้อความยาว ๆ>'      # ไม่ตั้ง = ปิดการเขียน (อ่านได้อย่างเดียว)
```

- **ไม่ใช้ endpoint พวกนี้ก็ได้** — Vercel ต่อ SQL Server ตัวนี้ตรงได้เลย (เครื่องเดียวกับที่
  ตารางงาน/หน้าสแกนหน้าต่ออยู่แล้ว) ตั้ง `QCRD_SOURCE=sql` + รหัสฐานข้อมูลบน Vercel พอ
  ดู "ทางที่ 1" ใน `docs/qcrd-sql-migration.md` — ส่วนนี้มีไว้สำหรับตอนที่ไม่อยากให้ Vercel ต่อ SQL ตรง
- ต่อฐานแบบ lazy เหมือน ZKBio — ยังไม่ได้ย้ายข้อมูลก็ไม่กระทบ endpoint ยอดขาย
- เช็กว่าพร้อมไหม: `http://localhost:14365/qcrd/ping`
- **`QCRD_WRITE_KEY` ต้องตั้งให้ตรงกับ env ชื่อเดียวกันบน Vercel** ไม่งั้นหน้าเว็บบันทึกไม่ได้
  (API ตัวนี้เปิดออกเน็ตและไม่มีระบบล็อกอิน กุญแจนี้คือด่านเดียวที่กันคนอื่นเขียนทับข้อมูล)

## endpoint ทั้งหมด

| Method | Path | คำอธิบาย |
|---|---|---|
| GET | `/ctranbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD` | รายการสินค้า (dbo.Ctrans) |
| GET | `/cpaidbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD` | รายบิล/การชำระ |
| GET | `/tables` | รายชื่อตาราง |
| GET | `/columns?table=ชื่อ` | คอลัมน์ของตาราง (default Ctrans) |
| GET | `/sample?table=ชื่อ` | ตัวอย่าง 1 แถว |
| GET | `/ping` | health check |
| GET | `/zk/transactions?start=…&end=…&emp=…` | log สแกนนิ้ว (ZKBio: iclock_transaction) |
| GET | `/zk/employees` | พนักงานในเครื่องสแกน + แผนก |
| GET | `/zk/ping` | เช็กการเชื่อมต่อฐาน ZKBio |
| GET | `/zk/tables` `/zk/columns?table=…` `/zk/sample?table=…` | debug schema ฝั่ง ZKBio |
| GET | `/qcrd/menu` `/qcrd/bom` `/qcrd/item` `/qcrd/menugroup` | ข้อมูล QC/RD จากฐาน InventoryNarai |
| POST | `/qcrd/save` | เพิ่ม/แก้/ลบ ของ QC/RD (ต้องมี header `x-api-key`) |
| GET | `/qcrd/ping` | เช็กการเชื่อมต่อฐาน QC/RD + เขียนได้ไหม |

ทุก endpoint คืน `{ data: [...] }` (ยกเว้น debug) โดยชื่อคอลัมน์แปลงเป็นตัวพิมพ์เล็กตัวแรก
ให้ตรงกับที่ frontend ใช้
