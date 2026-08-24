# ย้ายชีทที่เหลือ (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน) ไป SQL Server

> **คำตอบสั้น ๆ:** ย้ายได้ ไปอยู่ฐาน `InventoryNarai` บนเครื่องเดียวกับที่ดูสแกนเข้างาน-ออกงาน
> ต้องสร้าง **5 ตารางใหม่** — ทั้งหมดอยู่ในไฟล์เดียวคือ [`schema-sheets.sql`](schema-sheets.sql)
> แล้วกดย้ายข้อมูลเก่าจากหน้าเว็บด้วย `/api/sheets-migrate` (ไม่ต้องไปนั่งรันที่เครื่องออฟฟิศ)

ฝั่ง QC/RD ย้ายไปแล้ว (ดู [`qcrd-sql-migration.md`](qcrd-sql-migration.md)) ไฟล์นี้คือส่วนที่เหลือ

## 1) ปลายทางคือเครื่องเดียวกับที่ดูสแกนหน้า

`NARAI-PIZZARIA\SQLEXPRESS` ที่ออฟฟิศ — เครื่องเดียวกับที่เก็บ

| ฐานข้อมูล | ใช้ทำอะไร |
|---|---|
| `ZKBio9` | สแกนนิ้วเข้างาน-ออกงาน (หน้า "ดูสแกนหน้า") |
| `narai_hr` | ตารางงาน |
| `InventoryNarai` | สต๊อก (`stock_*`) + QC/RD (`qcrd_*`) + **ชุดใหม่ในไฟล์นี้** |

### หน้าเว็บไปถึงฐานได้ 2 ทาง

```
ทางที่ 1  เบราว์เซอร์ -> /api/* (Vercel) --ต่อ SQL ตรง--> SQL Server
ทางที่ 2  เบราว์เซอร์ -> /api/* (Vercel) -> host API /sheets/* -> SQL Server   ← ที่ร้านใช้ทางนี้
```

**ทางที่ 1 ใช้ไม่ได้ที่ร้าน** — probe เมื่อ 2026-08-21 พบว่า SQL Server ไม่ได้เปิดพอร์ตออกเน็ตเลย
ทดสอบจาก 2 ที่ (Vercel + เครื่องนอก) รวม 7 พอร์ต `1433, 3389, 8080, 14322, 14330, 14333, 14365`
timeout ทั้งหมด ทั้งที่ฝั่งเครื่องถูกต้องครบแล้ว:

| ชั้น | สถานะ |
|---|---|
| SQL Server ฟัง `0.0.0.0:1433` | ✅ |
| Windows Firewall ขาเข้า 1433 | ✅ Allow / Any |
| DNS `inventory.dyndns.tv` = `203.154.185.48` = IP จริงของร้าน | ✅ |
| ไม่ใช่ CGNAT (ในบ้านคือ `172.28.1.48`) | ✅ |
| **router forward `203.154.185.48` → `172.28.1.48`** | ❌ ไม่มีกฎเลยสักข้อ |

สรุปคือขาดกฎ port forward ที่ router ซึ่งอยู่นอกมือ ถ้าวันหลังเข้าถึง router ได้ ให้เพิ่มกฎเดียว

```
Protocol TCP · External 14330 · Internal 172.28.1.48 : 1433
```

แล้วเช็กด้วย `/api/sheets-migrate?key=...&step=probe&port=14330` ขึ้น ✅ เมื่อไหร่
ก็ตั้ง `QCRD_DB_PORT=14330` บน Vercel — **โค้ดจะสลับไปใช้ทางที่ 1 ให้เองทันที** เร็วกว่าและไม่ต้องแก้อะไร

**ทางที่ 2 คือทางที่ใช้อยู่** — host-server ที่เครื่องออฟฟิศเปิด tunnel ขาออกไปหา Cloudflare
(`https://api.khanoykorshabu.com`) ซึ่งพิสูจน์แล้วว่าใช้ได้ (`/ping` = HTTP 200)
ขาออกไม่ต้องพึ่ง port forward จึงไม่ต้องแตะ router เลย

## 2) ชีทไหนไปเป็นตารางอะไร

| ชีท / แท็บ | ใช้ที่หน้าไหน | ตารางใหม่ |
|---|---|---|
| สต๊อก `1xegMu…` แท็บ `plan` | จัดซื้อ > แพลนสินค้า | `dbo.stock_plan` |
| สต๊อก `1xegMu…` แท็บ `ปิดรอบสิ้นเดือน` | ยอดยกมาในหน้านับสต๊อก | `dbo.stock_closing` |
| ค่าใช้จ่าย `1YXOaA…` แท็บ `ข้อมูลค่าใช้อื่น` | ตัวเลือกในฟอร์มค่าใช้จ่ายอื่นๆ | `dbo.expense_ref` |
| ค่าใช้จ่าย `1YXOaA…` แท็บ `ค่าใช้จ่ายอื่น` | ค่าใช้จ่ายอื่นๆ (บันทึก/Export) | `dbo.expense_entry` |
| ชีทพนักงาน แท็บ `DATA` | รายชื่อพนักงาน | `dbo.hr_employee` (ย้ายไว้แล้ว แต่ **หน้าเว็บกลับไปใช้ชีทตามเดิม** ดูข้อ 5) |

รายละเอียดคอลัมน์และเหตุผลที่เลือกคีย์แบบนั้น อยู่ในคอมเมนต์ของ [`schema-sheets.sql`](schema-sheets.sql)

**สามอย่างที่ไม่ต้องสร้างตารางใหม่** — ข้อมูลอยู่ใน SQL ตั้งแต่รอบ QC/RD แล้ว
แค่สลับให้ API อ่านจากฐานแทนชีท (ทำไปพร้อมกันในรอบนี้):

| API | เคยอ่าน | ตอนนี้อ่าน (เมื่อ `QCRD_SOURCE=sql`) |
|---|---|---|
| `/api/cost` | ชีทต้นทุนเมนู แท็บ `menu` | `dbo.qcrd_menu` |
| `/api/menugroup` | ชีทต้นทุนเมนู แท็บ `menu` + `menucodegroup` | `dbo.qcrd_menu` + `dbo.qcrd_menu_group` |
| `/api/recipe` | ชีทเก่า `1Tjvt…` แท็บ `RcpDtls` | `dbo.qcrd_bom` |

> `/api/recipe` เปลี่ยนต้นทางจริง ๆ ไม่ใช่แค่ย้ายที่เก็บ — ชีท `RcpDtls` หยุดอัปเดตไปแล้ว
> ส่วน `qcrd_bom` คือสูตรที่ถูกแก้ทุกครั้งที่บันทึกจากหน้า QC/RD ผลลัพธ์จึงตรงกับความจริงมากกว่า

## 3) ตั้งค่าอะไรบ้างบน Vercel

| env | ค่า | ไว้ทำอะไร |
|---|---|---|
| `SHEETS_SOURCE` | `sheet` (เริ่มต้น) / `sql` | สลับให้หน้าเว็บอ่าน-เขียน SQL แทนชีท (**ไม่คุมส่วนพนักงาน** — พนักงานยึดชีทเสมอ) |
| `SHEETS_API_BASE` | URL ของ host API | ไม่ตั้ง = ใช้ `QCRD_API_BASE` หรือ `STORE_API_BASE` เดิม |
| `SHEETS_WRITE_KEY` | ให้ตรงกับเครื่องโฮสต์ | กุญแจฝั่งเขียน — ไม่ตั้งก็ใช้ `QCRD_WRITE_KEY` เดิมได้ |
| `QCRD_SOURCE` | — | **เลิกใช้แล้ว** QC/RD กลับไปอ่าน-เขียนชีท (ดู `docs/qcrd-sql-migration.md`) |
| `SHEETS_MIGRATE_KEY` | ตั้งเอง | เปิดใช้ `/api/sheets-migrate` — ไม่ตั้งก็ใช้ `QCRD_MIGRATE_KEY` เดิมได้ |

**ทางที่ 2 ไม่ต้องมีรหัสฐานข้อมูลบน Vercel เลย** — Vercel ไม่ได้ต่อ SQL เอง แค่ยิง HTTP ไปหา host API
(ถ้าตั้ง `QCRD_DB_USER`/`ZK_DB_USER` ไว้ โค้ดจะพยายามต่อตรงก่อน ซึ่งตอนนี้จะ timeout ทุกครั้ง
— ถ้าเจออาการหน้าเว็บช้า 15 วิแล้วค่อยขึ้นข้อมูล ให้ลบ env รหัสฐานออกเพื่อให้ข้ามไปใช้ host API เลย)

### ที่เครื่องออฟฟิศต้องตั้งอะไร

```powershell
$env:SHEETS_WRITE_KEY = '<สุ่มข้อความยาว ๆ>'   # ใช้ QCRD_WRITE_KEY เดิมก็ได้ ไม่ต้องตั้งซ้ำ
node host-server\server.js
```

เช็กว่าพร้อม: `http://localhost:14365/sheets/ping` → ต้องได้ `status: success` พร้อมจำนวนแถวของทั้ง 5 ตาราง

## 4) ลำดับการย้าย

ที่ร้านต้องย้ายจาก **เครื่องออฟฟิศ** เพราะ Vercel ต่อ SQL ตรงไม่ได้ (ดูข้อ 1)
เปิด PowerShell ที่โฟลเดอร์รีโปแล้วรันบรรทัดเดียว — ทำครบทั้งสร้างตาราง ย้าย และตรวจให้ในตัว

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\migrate-sheets.ps1
```

จะสำรวจต้นทางให้ดูก่อน แล้วถามยืนยันก่อนเขียนจริง ปลอดภัยที่จะรันซ้ำ (ทุกชุดเขียนแบบ MERGE)

ตัวเลือกที่ใช้บ่อย

```powershell
.\scripts\migrate-sheets.ps1 -Yes                      # ไม่ต้องถามยืนยัน
.\scripts\migrate-sheets.ps1 -SkipSchema               # สร้างตารางไปแล้ว
.\scripts\migrate-sheets.ps1 -Only plan,expense        # เฉพาะบางชุด
.\scripts\migrate-sheets.ps1 -DbName NARAITEST         # ลงฐานทดสอบก่อน
```

เรียก node ตรง ๆ ก็ได้ถ้าอยากคุมทีละขั้น

```powershell
node scripts\migrate-sheets.mjs --inspect     # สำรวจ ไม่แตะฐาน (ไม่ต้องมีรหัสฐานด้วยซ้ำ)
node scripts\migrate-sheets.mjs --dry-run     # อ่านครบ แปลงครบ แต่ไม่เขียน
node scripts\migrate-sheets.mjs               # ย้ายจริง
node scripts\migrate-sheets.mjs --verify      # เทียบจำนวน ต้นทาง ↔ SQL
```

### ถ้าวันหลังเปิดพอร์ต SQL ได้

จะกดย้ายจากหน้าเว็บแทนก็ได้ ไม่ต้องเข้าเครื่องออฟฟิศ

```
?key=<KEY>&step=check    →  &step=schema&confirm=1  →  &step=all&confirm=1  →  &step=verify
```

ทั้งสองทางเขียนลงตารางเดียวกันด้วยตรรกะชุดเดียวกัน (`lib/sheetsMigrate.mjs`) ผลลัพธ์เหมือนกันเป๊ะ

## 5) หลังตั้ง `SHEETS_SOURCE=sql` แล้วอะไรเปลี่ยนบ้าง

| ทาง | ก่อน | หลัง |
|---|---|---|
| `/api/plan` | อ่านชีท `plan` | อ่าน `dbo.stock_plan` |
| `/api/stock-closing` | โหลดทั้งชีทมาคัดที่ Vercel | ให้ SQL คัดแถวล่าสุดมาให้ (`ROW_NUMBER`) |
| `/api/expense-gas` ทุก action | ส่งต่อไป Apps Script | ทำกับ `expense_ref` / `expense_entry` ตรง ๆ |
| `/api/stock-gas` `getEmployees` / `saveEmployee` | ส่งต่อไป Apps Script | **ไม่เปลี่ยน** — ยังส่งต่อไป Apps Script เหมือนเดิม (ดู "พนักงานกลับไปใช้ชีท" ด้านล่าง) |
| เครื่องมือ AI (`get_expenses`, `get_purchase_plan`) | อ่านชีท/GAS | อ่าน SQL ชุดเดียวกับหน้าเว็บ |
| เครื่องมือ AI `get_employees_summary` | อ่านชีท/GAS | **ไม่เปลี่ยน** — อ่านชีทเหมือนหน้ารายชื่อพนักงาน |

action อื่นของสต๊อก (`getBranches`, `getStockItems`, `getStockTotal`, `saveStock` ฯลฯ)
**ยังใช้ Apps Script เหมือนเดิม** รอบนี้ไม่ได้แตะ

### ล่มแล้วเป็นยังไง

* **ฝั่งอ่าน** ต่อ SQL ไม่ได้ → ถอยไปอ่านชีทให้อัตโนมัติ แล้วแนบ `warning` มากับผลลัพธ์
  หน้าเว็บยังใช้ได้ต่อ แค่ข้อมูลอาจเก่ากว่าที่อยู่ในฐาน
* **ยกเว้นพนักงาน** (`getEmployees` / `saveEmployee` และเครื่องมือ AI `get_employees_summary`)
  — ไม่แตะ SQL เลย ยึดชีท `DATA` ผ่าน Apps Script ที่เดียวทั้งอ่านและเขียน
* **ฝั่งเขียน** (บันทึกค่าใช้จ่าย) **ไม่ถอยไปชีท** — ตอบว่าบันทึกไม่สำเร็จไปตรง ๆ
  เพราะเขียนลงชีทบ้างลงฐานบ้าง แปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น แล้วตามแก้ทีหลังไม่ไหว

### พนักงานกลับไปใช้ชีท

รายชื่อพนักงานย้ายเข้า `dbo.hr_employee` ไปรอบหนึ่งแล้วถอยกลับมาใช้ชีทตามเดิม
ตารางกับสคริปต์ย้ายข้อมูลยังอยู่ครบ (เผื่อย้ายอีกรอบ) แต่หน้าเว็บกับ AI ไม่ยิงไปหามันแล้ว

| ทำอะไร | ไปที่ไหน | ที่ไฟล์ |
|---|---|---|
| หน้ารายชื่อพนักงาน (อ่าน) | Apps Script → ชีท `DATA` | `pages/api/stock-gas.js` |
| แก้ข้อมูลพนักงาน (เขียน) | Apps Script → ชีท `DATA` เล่มเดียวกัน | `employee-apps-script.gs` |
| เครื่องมือ AI `get_employees_summary` | Apps Script → ชีท `DATA` | `pages/api/ai-chat.js` |

### อาการ "แก้ข้อมูลพนักงานแล้วกดบันทึก ขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน"

ต้นเหตุคือ **ที่เขียนกับที่อ่านไม่ใช่ที่เดียวกัน** ตัวเขียนจึงตอบสำเร็จตามจริง แต่รายชื่อที่หน้าเว็บ
อ่านกลับมาเป็นอีกที่ที่ไม่ได้ถูกเขียน ตอนนี้ทั้งอ่านและเขียนยิงไป Apps Script ตัวเดียวกันแล้ว

| กันยังไง | ที่ไฟล์ |
|---|---|
| `getEmployees` / `saveEmployee` ส่งต่อไป Apps Script ทั้งคู่ ไม่แตะ SQL และไม่ดู `SHEETS_SOURCE` | `pages/api/stock-gas.js` |
| เครื่องมือ AI `get_employees_summary` อ่านชีทผ่าน Apps Script ตัวเดียวกับหน้ารายชื่อ | `pages/api/ai-chat.js` |
| หลังบันทึก หน้าเว็บอ่านซ้ำแล้วเทียบค่าที่เพิ่งส่งไปทุกช่อง ไม่ตรง = ขึ้นแดงและไม่ปิดฟอร์ม | `components/EmployeeList.jsx` |
| ตัวเขียนฝั่ง Apps Script อ่านค่ากลับมาเช็กหลัง `setValue` (กันเซลล์ที่ถูก Protected range ล็อกไว้) | `employee-apps-script.gs` |

| ข้อความที่ขึ้น | แปลว่า | แก้ยังไง |
|---|---|---|
| `ยังไม่ได้เพิ่ม action saveEmployee ใน Apps Script` | สคริปต์ที่ deploy อยู่ยังไม่มี `saveEmployee_` | วางโค้ดจาก `employee-apps-script.gs` แล้ว deploy version ใหม่ (URL เดิม) |
| `ไม่มีช่องไหนถูกบันทึก — หาคอลัมน์ของ … ในชีทไม่เจอ` | หัวตารางในแท็บ `DATA` ไม่มีคอลัมน์นั้น | เพิ่มคอลัมน์ในชีท หรือเพิ่มชื่อหัวลง `EMP_HEADER_ALIASES` |
| `กดบันทึกแล้วแต่ค่าที่อ่านกลับมาจากชีทยังเป็นของเดิม` | สคริปต์เขียนคนละเล่มกับที่หน้าเว็บอ่าน | ใส่ ID ชีตพนักงานใน `EMP_SHEET_ID` ของสคริปต์ |
| `ไม่พบพนักงานรหัส …` | ไม่มีรหัสนั้นในแท็บ `DATA` | เช็กรหัสในชีทว่าตรงกันไหม (ช่องว่างหน้า-หลังด้วย) |

> ตาราง `dbo.hr_employee` กับ `/api/sheets-migrate` ยังอยู่ครบ เผื่อวันหลังจะย้ายพนักงานเข้า SQL อีกรอบ
> ตอนนี้หน้าเว็บกับ AI ไม่ได้ยิงไปหามัน

## 6) ชีทที่ยัง **ไม่ได้** ย้ายในรอบนี้

| ชีท | ใช้ที่หน้าไหน |
|---|---|
| `12Wb7t…` ใบเบิก + data | จัดซื้อ > เบิกของสาขา (`/api/branch-requisition`) |
| `1gijgB…` orders + PaymentSummary | ออเดอร์เพิ่มเติม (`/api/extra-orders`) |
| `1Tjvt…` UsageHistory | ยอดใช้จากระบบ (`/api/usage`) — ชีทนี้หยุดอัปเดตแล้ว |
| ชีทสต๊อก แท็บนับสต๊อก/เบิก ผ่าน Apps Script | นับสต๊อก (`getStockItems`, `saveStock` ฯลฯ) |

## 7) ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|---|---|
| `docs/schema-sheets.sql` | โครงตาราง 5 ตาราง (รันซ้ำได้) |
| `lib/sheetsSheet.mjs` | ตัวอ่านฝั่งชีท/GAS — ใช้ทั้งตอนย้ายและตอนถอยกลับ |
| `lib/sheetsMigrate.mjs` | แปลงแถวชีท → เรคคอร์ด + คำสั่ง MERGE |
| `lib/sheetsSql.mjs` | ตรรกะฝั่ง SQL (อ่าน/เขียน) ที่ Vercel กับ host-server ใช้ร่วมกัน |
| `lib/sheetsSource.js` | สวิตช์ `SHEETS_SOURCE` + เลือกทาง (ต่อตรง / host API) |
| `host-server/sheets-db.js` | endpoint `/sheets/*` ที่เครื่องออฟฟิศ |
| `scripts/migrate-sheets.ps1` | ย้ายข้อมูลจากเครื่องออฟฟิศ (บรรทัดเดียวจบ) |
| `scripts/migrate-sheets.mjs` | ตัวย้ายจริงที่ .ps1 เรียกใช้ |
| `pages/api/sheets-migrate.js` | ย้าย/probe จากหน้าเว็บ (ใช้ได้เมื่อต่อ SQL ตรงได้) |
