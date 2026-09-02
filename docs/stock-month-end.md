# ดูข้อมูลปิดรอบเดือน (STOCK) — อ่านจาก `dbo.stock_month_end`

หน้าใหม่ในเมนู **STOCK → ดูข้อมูลปิดรอบเดือน** แสดงยอดปิดรอบของเดือนที่เลือก
ตรงจากตาราง `dbo.stock_month_end` ในฐาน `InventoryNarai` — **ดูอย่างเดียว ไม่มีปุ่มแก้/บันทึก**

## ⚠️ คนละชุดกับ "ยอดยกมา (Endding)" ในหน้านับสต๊อก

| | ตาราง | ใครใช้ | คัดข้อมูลยังไง |
|---|---|---|---|
| ยอดยกมาในหน้านับสต๊อก | `dbo.stock_closing` | `/api/stock-closing` | คัดเฉพาะแถว**ล่าสุด**ของแต่ละไอเทม ต่อสาขา |
| หน้าดูข้อมูลปิดรอบเดือน | `dbo.stock_month_end` | `/api/stock-month-end` | แสดง**ทุกแถวของเดือนที่เลือก** ไม่คัดทิ้ง |

`dbo.stock_closing` เกิดจากการย้ายชีท "ปิดรอบสิ้นเดือน" เข้ามา (ดู `docs/schema-sheets.sql`)
ส่วน `dbo.stock_month_end` เป็นตารางที่**มีอยู่ในฐานอยู่แล้ว** รีโปนี้ไม่ได้สร้างและไม่ได้เขียนลงไป

## ทางไปถึงข้อมูล

เหมือนชุดอื่นในฐานนี้ทุกอย่าง (ดู `lib/sheetsSource.js`) — ลองตามลำดับ:

1. ต่อ SQL ตรงจาก Vercel (`lib/qcrdPool.js`) เมื่อมี `QCRD_DB_USER/PASSWORD` (หรือ `ZK_DB_*` / `HR_DB_*`)
2. host API ที่เครื่องออฟฟิศ — `GET /sheets/month-end?month=&branch=` และ `GET /sheets/month-end-months`
   (`host-server/sheets-db.js` — ต้อง **git pull แล้วรีสตาร์ท** host-server ถึงจะมี endpoint นี้)

**ต่อ SQL ตรงไม่ติดจะถอยไปทางที่ 2 ให้เอง** (ต่างจากชุดอื่นในไฟล์นี้ที่ยึดทางเดียวตามที่ตั้ง env ไว้)
เพราะที่ร้าน SQL ไม่ได้เปิดพอร์ตออกเน็ต แต่ `QCRD_DB_USER` ถูกตั้งไว้บน Vercel เพื่อใช้กับหน้าอื่นอยู่แล้ว
ถ้าไม่ถอยให้ หน้านี้จะตายที่ `Failed to connect to inventory.dyndns.tv:1433 in 15000ms` ทั้งที่ host API ใช้ได้
ถอยเฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น — ตารางไม่มี/ไม่มีสิทธิ์/จับคู่คอลัมน์ไม่ได้ ยังเด้งขึ้นมาให้แก้เหมือนเดิม
กล่องพับท้ายหน้าบอกว่ารอบนั้นอ่านผ่านทางไหน (`meta.source` ของ API ก็บอกเหมือนกัน)

ไม่มีทางถอยไปอ่านชีท เพราะข้อมูลชุดนี้ไม่เคยอยู่ในชีท — ไปไม่ถึงฐานทั้งสองทาง = หน้านั้นขึ้นข้อความบอกสาเหตุทั้งคู่

## API

```
GET /api/stock-month-end                          เดือนล่าสุดที่มีข้อมูล ทุกสาขา
GET /api/stock-month-end?month=2026-08            เดือนที่ระบุ (YYYY-MM)
GET /api/stock-month-end?month=2026-08&branch=CRM เฉพาะสาขานั้น
```

คืน `{ status, data: { month, months[], branches[], rows[], layout }, meta }`
โดย `rows[]` = `{ date, branch, itemCode, itemKey, itemName, unit, balance, unitValue, totalValue, recordedBy, recordedAt }`

## ชื่อคอลัมน์ — จับคู่ให้เองตอนอ่าน

ตารางนี้ไม่ได้ถูกสร้างจากรีโปนี้ จึงไม่การันตีว่าคอลัมน์ชื่ออะไร
`lib/monthEndSql.mjs` เลยอ่านชื่อคอลัมน์จริงจาก `INFORMATION_SCHEMA.COLUMNS` ก่อน
แล้วจับคู่กับรายชื่อที่รู้จักใน `MONTH_END_COLUMNS` (เทียบแบบไม่สนตัวพิมพ์/ขีดล่าง/ช่องว่าง —
`close_date`, `CloseDate`, `[close date]` ถือว่าตัวเดียวกัน)

| ช่องที่หน้าเว็บใช้ | คอลัมน์จริงที่ร้านใช้อยู่ | ชื่ออื่นที่รองรับด้วย |
|---|---|---|
| `date` (บังคับ) | `closing_date` (date) | close_date · month_end_date · end_date · stock_date · doc_date · period · month · date |
| `branch` | `branch` | branch_code · store · store_code · outlet · outlet_code |
| `itemCode` | `item_code` | product_code · product_id · item_id · code · sku |
| `itemKey` | `item_key` | product_key |
| `itemName` | `item_name` | product_name · name · description |
| `balance` (บังคับ) | `qty` (decimal) | balance · end_qty · closing_qty · quantity · stock_qty · remaining · remain |
| `unit` | `unit` | unit_name · uom |
| `unitValue` | `unit_price` | unit_value · unit_cost · cost · price |
| `totalValue` | `amount` | total_value · total_cost · total_amount · total |
| `recordedBy` | `recorder` | recorded_by · created_by · updated_by · user_name · username |
| `recordedAt` | `saved_at` (datetime2) | recorded_at · record_time · created_at · updated_at |
| `rowId` (ใช้เรียงเท่านั้น) | `closing_id` (bigint) | month_end_id · id |

โครงจริงที่ร้าน (เช็กเมื่อ 2026-09 — 15,104 แถว):
`closing_id · closing_date · branch · item_key · item_code · item_name · unit · qty · unit_price · amount · recorder · saved_at`

- ช่องที่ตารางไม่มีคอลัมน์ให้ — คอลัมน์นั้นจะ**หายไปจากตารางบนหน้าเว็บ**เลย (ไม่ใช่ขึ้น "-" ทั้งแถว)
- ขาด `date` หรือ `balance` = อ่านไม่ได้ หน้าเว็บจะขึ้น error ที่**บอกชื่อคอลัมน์จริงทั้งหมดของตารางมาด้วย**
  เอาชื่อนั้นไปเติมใน `MONTH_END_COLUMNS` ที่ `lib/monthEndSql.mjs` ไฟล์เดียวจบ
  (ไม่ต้องแก้ API/หน้าเว็บตาม) แล้วหน้าเว็บใช้ได้ทันที
- ที่ท้ายหน้ามีกล่องพับ "คอลัมน์ที่อ่านมาจาก dbo.stock_month_end" บอกว่าคอลัมน์ไหนถูกใช้เป็นช่องอะไร
  และตารางมีคอลัมน์อะไรบ้าง — ไว้ไล่ดูตอนตัวเลขไม่ตรงกับที่คิด

## เดือนของแต่ละแถว

- คอลัมน์วันที่เป็นชนิดวันที่ (`date`/`datetime`/`datetime2`/…) → แปลงเป็น `'YYYY-MM'` ด้วย `CONVERT(char(7), col, 126)`
- เก็บเป็นข้อความ → ถือว่าเขียนแบบ ISO (`'YYYY-MM-DD'` หรือ `'YYYY-MM'`) แล้วตัด 7 ตัวหน้า
  ถ้าที่ร้านเก็บเป็นแบบอื่น (เช่น `'DD/MM/YYYY'` หรือเลข `202608`) ต้องแก้ `monthExpr` ใน `lib/monthEndSql.mjs`
