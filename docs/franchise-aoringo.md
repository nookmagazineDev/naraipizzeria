# เมนู "เฟรนไชส์" — ข้อมูลจากฐาน Aoringo

เมนูสีเขียวในแถบซ้าย (คนละสีกับเมนูเดิมที่เป็นเหลืองอำพัน) มี 5 หน้าย่อย:

| หน้าย่อย | เห็นอะไร |
|---|---|
| แดชบอร์ด | ยอดขายรวม · จำนวนบิล · จำนวนลูกค้า · รายจ่าย · กราฟยอดขายรายวัน · ช่องทางชำระเงิน · เมนูขายดี 10 อันดับ · รายจ่ายตามประเภท |
| ยอดขายรายวัน | ตารางรายวัน: บิล · ลูกค้า · ยอดขาย · เฉลี่ย/บิล · แยกช่องทางชำระ · รายจ่ายของวันนั้น |
| รายการขาย | รายบิล (วันที่/เวลา · เลขที่บิล · โต๊ะ · ชำระโดย · แคชเชียร์ · ส่วนลด · VAT · ยอดบิล) |
| รายละเอียดการขาย | รายไอเทม — สลับได้ระหว่าง "สรุปตามเมนู" กับ "รายบรรทัด" |
| รายจ่าย | รายการรายจ่าย + สรุปเทียบกับยอดขาย |

ทุกหน้ามีช่องค้นหาและปุ่มส่งออก Excel · ทั้ง 5 หน้าใช้ข้อมูลชุดเดียวกัน โหลดครั้งเดียวแล้วสลับได้เลย

## ข้อมูลมาจากไหน

ฐานข้อมูล **`Aoringo`** บน **SQL Server 203.154.185.48** — เครื่องเดียวกับฐาน `InventoryNarai`
(QC/RD · นับสต๊อก · ทะเบียนสาขา) และ `ZKBio9` (สแกนหน้า) ที่โปรเจกต์นี้ใช้อยู่แล้ว
ต่างกันแค่ "ฐานข้อมูล" จึงใช้ทางเดิมทั้งหมดได้ ไม่ต้องเปิดพอร์ตใหม่

ทางไปถึงฐานมีสองทาง ลองตามลำดับนี้ (เหมือนหน้า "ดูข้อมูลปิดรอบเดือน"):

1. **ต่อ SQL ตรงจาก Vercel** — `lib/aoringoPool.js` เร็วที่สุด ใช้ได้เมื่อพอร์ตเปิดให้ IP ของ Vercel
2. **host API `/aoringo/*`** — `host-server/aoringo-db.js` วิ่งผ่าน tunnel ขาออกของเครื่องออฟฟิศ
   (ที่ร้านเปิดไฟร์วอลล์ให้เฉพาะ IP ในไทย ปกติจึงตกมาใช้ทางนี้)

ถอยไปทางที่ 2 เฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น — error แบบไม่มีสิทธิ์/หาตารางไม่เจอ
จะเด้งขึ้นหน้าเว็บให้คนอ่านแก้ ไม่ถูกกลบด้วยการถอย

```
หน้าเว็บ (components/Franchise.jsx)
   └─ /api/franchise?view=all&start=…&end=…      (pages/api/franchise.js)
        └─ lib/aoringoSource.js  ── ต่อตรง ─▶ lib/aoringoPool.js ─┐
                                 └─ ถอย ────▶ host API /aoringo/* ┤
                                                                  └─▶ lib/aoringoSql.mjs (ตรรกะชุดเดียวกันทั้งสองทาง)
```

## โครงฐานจริงที่ร้านใช้ (โหมด `app`)

ตรวจเมื่อ 2026-09 ฐาน Aoringo ไม่ใช่โครง POS แบบ NaraiPos แต่เป็นแอปร้านอาหารที่กระจายข้อมูลหลายตาราง
โค้ดจึงมีตัวอ่านเฉพาะสำหรับโครงนี้ (`buildAppPlan` ใน `lib/aoringoSql.mjs`) ซึ่งถูกเลือกอัตโนมัติ
เมื่อเจอทั้ง `SaleOrder` และ `SaleOrderItem`:

| ข้อมูล | มาจาก |
|---|---|
| บิล | `SaleOrder` (`OrderNo` · `Total` · `SubTotal` · `VatAmount` · `DiscountAmount` · `ServiceChargeAmount` · `GuestCount` · `OrderType` · `Status`) |
| วันที่ของบิล | `COALESCE(PaidAt, OrderDate, OpenedAt)` — ยึดเวลาปิดบิลก่อน ยังไม่ปิดค่อยใช้เวลาเปิดออร์เดอร์ |
| ช่องทางชำระ | `OrderPayment` ยุบเป็นบิลละแถว แล้วจัดเข้าถัง (เงินสด/บัตร/QR/QR Credit/Voucher/เดลิเวอรี) ตามชื่อวิธีจ่าย |
| รายการสินค้า | `SaleOrderItem` (ไม่มีคอลัมน์วันที่ ต้อง join `SaleOrder`) + ชื่อ/รหัสจาก `MenuItem` + หมวดจาก `Category` |
| คนปิดบิล | `AppUser` join ด้วย `PaidByUserId` (join ให้เมื่อตรวจเจอคอลัมน์ที่ตรงเท่านั้น) |
| บิลที่ยกเลิก | `Status` มีคำว่า void/cancel/refund/ยกเลิก/คืนเงิน → ตัดออกจากยอดขาย |
| รายจ่าย | `Expense` (`ExpenseDate` · `CategoryName` · `ItemName` · `Qty` × `UnitPrice` → `Amount`) |

ทุกคอลัมน์ยังเช็กก่อนใช้ว่ามีจริง — แอปเวอร์ชันหน้าเพิ่ม/ตัดคอลัมน์แล้วหน้าเว็บต้องไม่ล้มทั้งหน้า
อยากดูคำสั่ง SQL ที่ยิงจริง เปิด `/api/franchise?view=schema` แล้วดูช่อง `sqlPreview` ของแต่ละบทบาท

บังคับกลับไปใช้ตัวจับคู่อัตโนมัติได้ด้วย `AORINGO_SCHEMA_MODE=generic` (หรือตั้ง `AORINGO_*_TABLE` ตัวใดตัวหนึ่ง)

## การจับคู่ตาราง/คอลัมน์อัตโนมัติ (โหมด `generic` — ใช้กับฐานอื่นที่ไม่ใช่โครงข้างบน)

ฐาน Aoringo เป็นของร้านเฟรนไชส์ ไม่มีใครรับประกันว่าชื่อตาราง/คอลัมน์จะตรงกับ `dbo.Cpaid` /
`dbo.Ctrans` ของ NaraiPos `lib/aoringoSql.mjs` จึงอ่าน `INFORMATION_SCHEMA` ตอนรัน แล้วให้คะแนน
หาตารางที่ "หน้าตาเหมือน" 3 บทบาท (บิล · รายการสินค้า · รายจ่าย) โดยดูที่คอลัมน์เป็นหลัก
ชื่อตารางเป็นแค่ตัวช่วย จากนั้นจับคู่คอลัมน์ตามรายการชื่อที่เป็นไปได้ ช่องไหนไม่มีก็ปล่อยว่าง

ดูว่าตอนนี้จับคู่ไปที่ไหน:

```
/api/franchise?view=schema      ← ตาราง/คอลัมน์ที่เลือก + ตารางอื่นที่คะแนนรองลงมา + รายชื่อตารางทั้งหมด
/api/franchise?view=diag        ← ต่อฐานได้ไหม ทางไหนพัง ต้องไปแก้ตรงไหน
```

เดาผิดให้ตั้งทับด้วย env (ตั้งบน Vercel และ/หรือเครื่องโฮสต์):

| env | ใช้ทำอะไร |
|---|---|
| `AORINGO_BILL_TABLE` | ชื่อตารางบิล เช่น `dbo.Cpaid` |
| `AORINGO_ITEM_TABLE` | ชื่อตารางรายการสินค้าในบิล |
| `AORINGO_EXPENSE_TABLE` | ชื่อตารางรายจ่าย |
| `AORINGO_BILL_DATE_COL` / `AORINGO_ITEM_DATE_COL` / `AORINGO_EXPENSE_DATE_COL` | คอลัมน์วันที่ที่ใช้กรองช่วง |

ฐานไหนไม่มีตารางรายจ่ายเลย หน้าอื่นยังใช้ได้ปกติ — หน้า "รายจ่าย" จะขึ้นคำเตือนพร้อมวิธีแก้แทน

## ตั้งค่าเชื่อมต่อ

### บน Vercel (ต่อ SQL ตรง)

ไม่ต้องตั้งอะไรเลยถ้า login เดิม (`QCRD_DB_USER` / `ZK_DB_USER` / `HR_DB_USER`) มีสิทธิ์อ่านฐาน Aoringo ด้วย
อยากแยก login ให้ตั้ง `AORINGO_DB_USER` / `AORINGO_DB_PASSWORD`

| env | ค่าเริ่มต้น |
|---|---|
| `AORINGO_DB_HOST` | `203.154.185.48` (ไม่ตั้ง → ใช้ `QCRD_DB_HOST` / `HR_DB_HOST` / `ZK_DB_HOST` ก่อน) |
| `AORINGO_DB_PORT` | `1433` |
| `AORINGO_DB_NAME` | `Aoringo` |
| `AORINGO_DB_USER` / `AORINGO_DB_PASSWORD` | ไม่ตั้ง → ใช้ `QCRD_DB_*` → `ZK_DB_*` → `HR_DB_*` |
| `AORINGO_DB_ENCRYPT` | `1` เมื่อเปิด TLS ที่ SQL Server แล้ว |
| `AORINGO_API_BASE` | ที่อยู่ host API (ไม่ตั้ง → ใช้ `SHEETS_API_BASE` / `QCRD_API_BASE` / `STORE_API_BASE`) |

⚠️ login ต้องมีสิทธิ์ใน **ฐาน Aoringo** ด้วย ไม่ใช่แค่ InventoryNarai — ไม่งั้นต่อติดแต่ query ไม่ผ่าน
("is not able to access the database") ที่เครื่อง SQL สั่งครั้งเดียว:

```sql
USE Aoringo;
CREATE USER [<login>] FOR LOGIN [<login>];
ALTER ROLE db_datareader ADD MEMBER [<login>];   -- หน้านี้อ่านอย่างเดียว ไม่ต้องให้สิทธิ์เขียน
```

### บนเครื่องออฟฟิศ (host API)

`host-server/aoringo-db.js` ต่อฐานเองแบบ lazy ไม่ตั้งอะไรก็ใช้ค่าเดียวกับ QC/RD แต่เปลี่ยนฐานเป็น `Aoringo`
(`AORINGO_DB_SERVER` · `AORINGO_DB_NAME` · `AORINGO_DB_USER` / `AORINGO_DB_PASSWORD` ตั้งทับได้)

หลัง `git pull` ต้องรีสตาร์ทก่อน endpoint ใหม่ถึงจะโผล่ (`node` ถือโค้ดเวอร์ชันตอนที่มันเริ่ม):

```powershell
powershell -ExecutionPolicy Bypass -File .\start-narai.ps1 -Restart
curl.exe http://localhost:14365/aoringo/ping     # ต้องได้ชื่อฐาน + ตารางที่จับคู่ได้
```

## endpoint ที่มี

| ทาง | endpoint |
|---|---|
| Vercel | `/api/franchise?view=all\|sales\|detail\|expense\|schema\|diag&start=YYYY-MM-DD&end=YYYY-MM-DD` |
| host | `/aoringo/ping` · `/aoringo/schema` · `/aoringo/sales` · `/aoringo/detail` · `/aoringo/expense` |

เมนูนี้ **อ่านอย่างเดียว** ไม่มีฝั่งเขียน จึงไม่ต้องมีกุญแจ (`x-api-key`) เหมือน `/qcrd/save` และ `/sheets/save`
