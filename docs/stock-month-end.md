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

ไม่มีทางถอยไปอ่านชีท เพราะข้อมูลชุดนี้ไม่เคยอยู่ในชีท — ต่อฐานไม่ได้ = หน้านั้นขึ้นข้อความบอกสาเหตุ

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

| ช่องที่หน้าเว็บใช้ | ชื่อคอลัมน์ที่รู้จัก (เรียงตามลำดับที่เลือก) |
|---|---|
| `date` (บังคับ) | close_date · month_end_date · end_date · stock_date · doc_date · period · month · date |
| `branch` | branch · branch_code · store · store_code · outlet · outlet_code |
| `itemCode` | item_code · product_code · product_id · item_id · code · sku |
| `itemKey` | item_key · product_key |
| `itemName` | item_name · product_name · name · description |
| `unit` | unit · unit_name · uom |
| `balance` (บังคับ) | balance · end_qty · closing_qty · qty · quantity · stock_qty · remaining · remain |
| `unitValue` | unit_value · unit_cost · unit_price · cost · price |
| `totalValue` | total_value · total_cost · total_amount · amount · total |
| `recordedBy` | recorded_by · created_by · updated_by · user_name · username |
| `recordedAt` | recorded_at · record_time · created_at · updated_at · saved_at |

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
