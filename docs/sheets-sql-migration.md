# ย้ายชีทที่เหลือ (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน) ไป SQL Server

> **คำตอบสั้น ๆ:** ย้ายได้ ไปอยู่ฐาน `InventoryNarai` บนเครื่องเดียวกับที่ดูสแกนเข้างาน-ออกงาน
> ต้องสร้าง **5 ตารางใหม่** — ทั้งหมดอยู่ในไฟล์เดียวคือ [`schema-sheets.sql`](schema-sheets.sql)
> แล้วกดย้ายข้อมูลเก่าจากหน้าเว็บด้วย `/api/sheets-migrate` (ไม่ต้องไปนั่งรันที่เครื่องออฟฟิศ)

ฝั่ง QC/RD ย้ายไปแล้ว (ดู [`qcrd-sql-migration.md`](qcrd-sql-migration.md)) ไฟล์นี้คือส่วนที่เหลือ

## 1) ปลายทางคือเครื่องเดียวกับที่ดูสแกนหน้า

`NARAI-PIZZARIA\SQLEXPRESS` ที่ `inventory.dyndns.tv` — เครื่องเดียวกับที่เก็บ

| ฐานข้อมูล | ใช้ทำอะไร |
|---|---|
| `ZKBio9` | สแกนนิ้วเข้างาน-ออกงาน (หน้า "ดูสแกนหน้า") |
| `narai_hr` | ตารางงาน |
| `InventoryNarai` | สต๊อก (`stock_*`) + QC/RD (`qcrd_*`) + **ชุดใหม่ในไฟล์นี้** |

เครื่องนี้ตรึง TCP 1433 และเปิดออกเน็ตอยู่แล้ว หน้าเว็บบน Vercel จึงต่อ SQL ตรงได้เลย
ไม่ต้องรัน host-server ไม่ต้องเปิด tunnel

## 2) ชีทไหนไปเป็นตารางอะไร

| ชีท / แท็บ | ใช้ที่หน้าไหน | ตารางใหม่ |
|---|---|---|
| สต๊อก `1xegMu…` แท็บ `plan` | จัดซื้อ > แพลนสินค้า | `dbo.stock_plan` |
| สต๊อก `1xegMu…` แท็บ `ปิดรอบสิ้นเดือน` | ยอดยกมาในหน้านับสต๊อก | `dbo.stock_closing` |
| ค่าใช้จ่าย `1YXOaA…` แท็บ `ข้อมูลค่าใช้อื่น` | ตัวเลือกในฟอร์มค่าใช้จ่ายอื่นๆ | `dbo.expense_ref` |
| ค่าใช้จ่าย `1YXOaA…` แท็บ `ค่าใช้จ่ายอื่น` | ค่าใช้จ่ายอื่นๆ (บันทึก/Export) | `dbo.expense_entry` |
| ชีทพนักงาน แท็บ `DATA` | รายชื่อพนักงาน | `dbo.hr_employee` |

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
| `SHEETS_MIGRATE_KEY` | ตั้งเอง (รหัสอะไรก็ได้ที่เดายาก) | เปิดใช้ `/api/sheets-migrate` — ไม่ตั้ง = ปิดทางนี้ทั้งหมด |
| `SHEETS_SOURCE` | `sheet` (เริ่มต้น) / `sql` | สลับให้หน้าเว็บอ่าน-เขียน SQL แทนชีท |
| `QCRD_SOURCE` | `sheet` (เริ่มต้น) / `sql` | คุมฝั่ง QC/RD + `/api/cost`, `/api/menugroup`, `/api/recipe` |

**รหัสฐานข้อมูลไม่ต้องตั้งใหม่** — ใช้ชุดเดียวกับ QC/RD (`lib/qcrdPool.js` เลือกให้เอง
ตามลำดับ `QCRD_DB_*` → `ZK_DB_*` → `HR_DB_*`) ถ้ายังไม่เคยตั้งเลย ให้ตั้ง `QCRD_DB_USER` /
`QCRD_DB_PASSWORD` แล้ว Redeploy

⚠️ login ที่ใช้ต้องมีสิทธิ์ในฐาน `InventoryNarai` — คำสั่งให้สิทธิ์อยู่ท้าย `schema-sheets.sql`
ถ้ายังไม่ให้ จะต่อติดแต่ query ไม่ผ่าน ขึ้นว่า `is not able to access the database`

## 4) ลำดับการย้าย

ทุก step เรียกผ่านเบราว์เซอร์ได้เลย (`<เว็บ>` = โดเมนที่ deploy ไว้)

```
1. เช็กก่อนว่าต่อฐานได้ไหม / ตารางครบยัง / login มีสิทธิ์อะไร
   https://<เว็บ>/api/sheets-migrate?key=<KEY>&step=check

2. สร้างตาราง 5 ตาราง (ข้ามได้ถ้ารัน schema-sheets.sql ที่เครื่องออฟฟิศแล้ว)
   https://<เว็บ>/api/sheets-migrate?key=<KEY>&step=schema&confirm=1

3. ลองย้ายแบบไม่เขียนจริงก่อน — ดูว่าอ่านชีทได้กี่แถว จะเขียนกี่แถว
   https://<เว็บ>/api/sheets-migrate?key=<KEY>&step=all

4. ย้ายจริงทุกชุด
   https://<เว็บ>/api/sheets-migrate?key=<KEY>&step=all&confirm=1

5. เทียบจำนวน ชีท ↔ SQL
   https://<เว็บ>/api/sheets-migrate?key=<KEY>&step=verify

6. ครบแล้วค่อยตั้ง SHEETS_SOURCE=sql (และ QCRD_SOURCE=sql ถ้ายังไม่ได้ตั้ง) แล้ว Redeploy
```

ย้ายทีละชุดก็ได้ ใช้ `&step=plan` / `closing` / `expenseref` / `expense` / `employee` แทน `all`

**ถ้าตอบกลับมาว่า `done: false`** แปลว่าชนเพดานเวลา 60 วิของ Vercel ก่อนจะจบ
ให้เรียกซ้ำตาม `nextOffset` ที่แนบมา เช่น
`?key=<KEY>&step=plan&confirm=1&offset=4200` — ย้ายซ้ำกี่รอบก็ได้ ทุกชุดเขียนแบบ MERGE
(มีอยู่แล้วทับของเดิม ไม่มีค่อยเพิ่ม) จึงไม่เกิดแถวซ้ำ

**ต่อฐานไม่ติดเลย** ให้ไล่หาพอร์ตที่เปิดจริงด้วยตัวเดิมของ QC/RD:
`/api/qcrd-migrate?key=<QCRD_MIGRATE_KEY>&step=probe` แล้วตั้ง `QCRD_DB_HOST` / `QCRD_DB_PORT` ให้ตรง

## 5) หลังตั้ง `SHEETS_SOURCE=sql` แล้วอะไรเปลี่ยนบ้าง

| ทาง | ก่อน | หลัง |
|---|---|---|
| `/api/plan` | อ่านชีท `plan` | อ่าน `dbo.stock_plan` |
| `/api/stock-closing` | โหลดทั้งชีทมาคัดที่ Vercel | ให้ SQL คัดแถวล่าสุดมาให้ (`ROW_NUMBER`) |
| `/api/expense-gas` ทุก action | ส่งต่อไป Apps Script | ทำกับ `expense_ref` / `expense_entry` ตรง ๆ |
| `/api/stock-gas` `getEmployees` / `saveEmployee` | ส่งต่อไป Apps Script | ทำกับ `hr_employee` ตรง ๆ |
| เครื่องมือ AI (`get_expenses`, `get_employees_summary`, `get_purchase_plan`) | อ่านชีท/GAS | อ่าน SQL ชุดเดียวกับหน้าเว็บ |

action อื่นของสต๊อก (`getBranches`, `getStockItems`, `getStockTotal`, `saveStock` ฯลฯ)
**ยังใช้ Apps Script เหมือนเดิม** รอบนี้ไม่ได้แตะ

### ล่มแล้วเป็นยังไง

* **ฝั่งอ่าน** ต่อ SQL ไม่ได้ → ถอยไปอ่านชีทให้อัตโนมัติ แล้วแนบ `warning` มากับผลลัพธ์
  หน้าเว็บยังใช้ได้ต่อ แค่ข้อมูลอาจเก่ากว่าที่อยู่ในฐาน
* **ฝั่งเขียน** (บันทึกค่าใช้จ่าย / แก้ข้อมูลพนักงาน) **ไม่ถอยไปชีท** — ตอบว่าบันทึกไม่สำเร็จไปตรง ๆ
  เพราะเขียนลงชีทบ้างลงฐานบ้าง แปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น แล้วตามแก้ทีหลังไม่ไหว

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
| `lib/sheetsSheet.js` | ตัวอ่านฝั่งชีท/GAS — ใช้ทั้งตอนย้ายและตอนถอยกลับ |
| `lib/sheetsMigrate.mjs` | แปลงแถวชีท → เรคคอร์ด + คำสั่ง MERGE |
| `lib/sheetsSource.js` | สวิตช์ `SHEETS_SOURCE` + ตัวอ่าน-เขียนฝั่ง SQL |
| `pages/api/sheets-migrate.js` | ตัวย้ายข้อมูลที่กดจากหน้าเว็บ |
