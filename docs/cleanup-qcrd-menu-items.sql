/* ============================================================================
   หน้าเมนู QC/RD มีแถว "วัตถุดิบ" ปนอยู่ — สำรวจ / สำรอง / ลบ

   ทำไมถึงมี
   ---------------------------------------------------------------------------
   dbo.qcrd_menu เป็นสำเนาของชีท 'menu' แบบแถวต่อแถว (ดู lib/qcrdMigrate.mjs
   ฟังก์ชัน mapMenus + menuStmt) — ไม่มีตัวกรองอะไรเลย มีอะไรในชีทก็ขึ้นหน้าเว็บหมด
   และหน้า QC/RD (components/QcRdMenu.jsx) ก็แสดงทุกแถวที่ readMenus() คืนมา
   ดังนั้นแถววัตถุดิบพวกนี้มาจากชีทตั้งแต่ต้น ไม่ได้เกิดจากตัวโปรแกรม

   แถวพวกนั้นในชีทมักมาจากสองทาง
     1) ของทำเอง/สูตรกลาง (ซอส น้ำสต๊อก แป้ง ฯลฯ) ที่ต้องมีชื่ออยู่ในทะเบียนเมนู
        เพราะระบบเก็บสูตร (dbo.qcrd_bom) ผูกกับ "รหัสเมนู" เท่านั้น
        ไม่ลงเป็นเมนูก็ใส่สูตรให้มันไม่ได้ และเมนูอื่นก็ดึงสูตรมันมาใช้ต่อไม่ได้
     2) ของเหลือจากการก๊อปทะเบียนวัตถุดิบ/รหัส POS มาวางในชีท แล้วไม่ได้ลบทิ้ง
        สังเกตได้จาก group_code / price / status ว่าง มีแต่ cost (ตรงกับที่เห็นในภาพ)

   ลบได้ไหม — ได้ แต่ต้องเช็กสามอย่างก่อน ไม่งั้นพังเงียบ ๆ
     ก) แถวนั้นมีสูตรของตัวเองใน qcrd_bom ไหม (ลบแล้วสูตรลอย ไม่มีเจ้าของ)
     ข) มีเมนูอื่นดึงสูตรมันไปใช้ไหม (qcrd_bom.src_code) — ลบแล้ว cascade คิดต้นทุน
        ย้อนกลับไปหาต้นทางไม่เจอ ต้นทุนเมนูปลายทางจะค้างค่าเก่าไว้ตลอด
     ค) POS เคยขายรหัสนั้นจริงไหม — /api/cost อ่าน cost จากตารางนี้ไปคิดกำไรต่อบิล
        ถ้าเคยขายแล้วลบทิ้ง ช่องต้นทุนในรายงานขายจะกลายเป็นว่าง

   ⚠️ สองข้อที่ต้องรู้ก่อนรัน
     1) ถ้ายังไม่ได้ตั้ง env QCRD_SOURCE=sql หน้าเว็บยังอ่านจากชีทอยู่ (lib/qcrdSource.js)
        ลบใน SQL แล้วหน้าเมนูจะไม่เปลี่ยนอะไรเลย — ต้องไปลบในชีทด้วย
     2) ถึงจะเปิด sql แล้ว ก็ต้องลบแถวเดียวกันในชีท 'menu' ด้วยอยู่ดี
        เพราะ menuStmt ใช้ MERGE (ไม่มี WHEN NOT MATCHED BY SOURCE DELETE)
        ครั้งหน้าที่ใครกด /api/qcrd-migrate แถวที่ลบไปจะถูกดันกลับมาทั้งชุด

   รันที่ SSMS (เลือกฐาน InventoryNarai) หรือ:
     sqlcmd -S localhost\SQLEXPRESS -E -d InventoryNarai -i docs\cleanup-qcrd-menu-items.sql
   ============================================================================ */
USE InventoryNarai;
GO

/* ===========================================================================
   1) สำรวจก่อน — READ-ONLY ยังไม่ลบอะไร
   "ต้องสงสัย" = รหัสนั้นมีอยู่ในทะเบียนวัตถุดิบ (stock_item) ด้วย
   ซึ่งเป็นสัญญาณที่แม่นกว่าดูจากชื่อ เพราะชื่อวัตถุดิบกับชื่อเมนูเขียนปนกันได้
   =========================================================================== */
SELECT
    m.menu_code,
    m.menu_name,
    m.group_code,
    m.price,
    m.cost,
    m.status,
    i.item_name                                   AS ชื่อในทะเบียนวัตถุดิบ,
    i.unit                                        AS หน่วย,
    ISNULL(b.own_lines, 0)                        AS สูตรของตัวเอง_กี่แถว,
    ISNULL(s.used_by, 0)                          AS ถูกเมนูอื่นดึงสูตรไปใช้_กี่แถว,
    CASE
        WHEN ISNULL(b.own_lines, 0) > 0 OR ISNULL(s.used_by, 0) > 0
            THEN N'⚠️ อย่าลบ — เป็นสูตรกลางที่ระบบยังใช้อยู่'
        WHEN m.price IS NOT NULL
            THEN N'⚠️ มีราคาขาย — น่าจะเป็นเมนูจริง'
        ELSE N'ลบได้'
    END                                           AS คำแนะนำ
FROM dbo.qcrd_menu m
INNER JOIN dbo.stock_item i
        ON i.item_key = m.menu_key                       -- อยู่ในทะเบียนวัตถุดิบด้วย
LEFT JOIN (SELECT menu_code, COUNT(*) AS own_lines
           FROM dbo.qcrd_bom GROUP BY menu_code) b
        ON b.menu_code = m.menu_code
LEFT JOIN (SELECT src_code, COUNT(*) AS used_by
           FROM dbo.qcrd_bom WHERE src_code IS NOT NULL AND src_code <> N'' GROUP BY src_code) s
        ON s.src_code = m.menu_code
ORDER BY คำแนะนำ DESC, m.sort_order;
GO

/* --- 1ข) เช็กยอดขายจริงฝั่ง POS ย้อนหลัง 12 เดือน (ข้อ ค ข้างบน) ---
   ⚠️ NaraiPos.dbo.Ctrans ~7.5 ล้านแถวและอาจยังไม่มี index ตาม PostTime
      (ดู scripts/fix-sales-index.mjs) — คิวรีนี้อาจกินเวลาหลายนาที
      รันตอนปิดร้าน หรือข้ามไปถ้ามั่นใจว่ารหัสพวกนี้ไม่เคยขาย
   ItemCode ฝั่ง POS กับรหัสเมนูเขียนไม่ตรงกัน ('00123' กับ '123')
   จึงตัด 0 นำหน้าทั้งสองฝั่งก่อนจับคู่ ให้ผลเหมือน normCode() ใน lib/qcrdSql.mjs */
WITH pos_sold AS (
    SELECT DISTINCT LOWER(SUBSTRING(k, PATINDEX('%[^0]%', k + '.'), 50)) AS item_key
    FROM (
        SELECT LTRIM(RTRIM(CONVERT(NVARCHAR(50), c.ItemCode))) AS k
        FROM NaraiPos.dbo.Ctrans c
        WHERE c.PostTime >= DATEADD(MONTH, -12, GETDATE())
    ) x
    WHERE x.k <> N''
)
SELECT m.menu_code, m.menu_name, m.cost,
       CASE WHEN p.item_key IS NULL THEN N'ไม่เคยขาย — ลบได้'
            ELSE N'⚠️ POS เคยขายรหัสนี้ — ลบแล้วต้นทุนในรายงานขายจะหาย' END AS ยอดขาย12เดือน
FROM dbo.qcrd_menu m
INNER JOIN dbo.stock_item i ON i.item_key = m.menu_key
LEFT JOIN pos_sold p ON p.item_key = m.menu_key
ORDER BY ยอดขาย12เดือน DESC, m.menu_code;
GO

/* ===========================================================================
   2) สำรองก่อนลบ — เก็บทั้งแถวเมนูและสูตรที่เกี่ยวข้องไว้ในตารางสำรอง
   ตารางสำรองอยู่ในฐานเดิม กู้คืนได้ด้วย INSERT ... SELECT (ดูท้ายไฟล์)
   =========================================================================== */
IF OBJECT_ID(N'dbo.qcrd_menu_backup_itemrows', N'U') IS NOT NULL
    DROP TABLE dbo.qcrd_menu_backup_itemrows;
GO
IF OBJECT_ID(N'dbo.qcrd_bom_backup_itemrows', N'U') IS NOT NULL
    DROP TABLE dbo.qcrd_bom_backup_itemrows;
GO

/* ชุดที่จะลบ: อยู่ในทะเบียนวัตถุดิบ + ไม่มีสูตรของตัวเอง + ไม่มีใครดึงสูตรไปใช้ + ไม่มีราคาขาย
   แก้เงื่อนไขตรงนี้ได้ตามผลสำรวจข้อ 1 แต่ต้องแก้ให้ตรงกันทั้ง 3 จุด (สำรอง/ลบ/นับ) */
SELECT m.*
INTO dbo.qcrd_menu_backup_itemrows
FROM dbo.qcrd_menu m
WHERE EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = m.menu_key)
  AND NOT EXISTS (SELECT 1 FROM dbo.qcrd_bom b WHERE b.menu_code = m.menu_code)
  AND NOT EXISTS (SELECT 1 FROM dbo.qcrd_bom b WHERE b.src_code  = m.menu_code)
  AND m.price IS NULL;
GO

SELECT b.*
INTO dbo.qcrd_bom_backup_itemrows
FROM dbo.qcrd_bom b
WHERE b.menu_code IN (SELECT menu_code FROM dbo.qcrd_menu_backup_itemrows);
GO

SELECT COUNT(*) AS จะลบกี่แถว FROM dbo.qcrd_menu_backup_itemrows;
GO

/* ===========================================================================
   3) ลบจริง — ครอบ transaction ไว้ ดูจำนวนแถวก่อนแล้วค่อยเลือก COMMIT/ROLLBACK
      ลบสูตรก่อนเมนูเสมอ (ชุดนี้ไม่ควรมีสูตรอยู่แล้ว ใส่ไว้กันตกค้าง)
   =========================================================================== */
BEGIN TRANSACTION;

DELETE b
FROM dbo.qcrd_bom b
WHERE b.menu_code IN (SELECT menu_code FROM dbo.qcrd_menu_backup_itemrows);

DELETE m
FROM dbo.qcrd_menu m
WHERE m.menu_code IN (SELECT menu_code FROM dbo.qcrd_menu_backup_itemrows);

SELECT @@ROWCOUNT AS ลบเมนูไปกี่แถว;

-- ตรวจดูตัวเลขให้พอใจก่อน แล้วรันบรรทัดที่ต้องการทีละบรรทัด:
-- COMMIT TRANSACTION;     -- ยืนยันการลบ
-- ROLLBACK TRANSACTION;   -- ยกเลิก กลับไปเหมือนเดิมทั้งหมด
GO

/* ===========================================================================
   4) ทางเลือกที่ปลอดภัยกว่า — ไม่ลบ แค่ปิดการใช้งาน
      หน้า QC/RD มีตัวกรองสถานะอยู่แล้ว (components/QcRdMenu.jsx)
      ปิดแล้วเลือกกรอง 'ใช้งาน' ก็ไม่เห็นแถวพวกนี้ และไม่กระทบสูตร/ต้นทุนอะไรเลย
      เอากลับมาได้ทันทีถ้าลบผิดตัว — แนะนำให้ทำแบบนี้ก่อน ถ้ายังไม่ชัวร์
   =========================================================================== */
-- UPDATE m
-- SET    m.status = N'ปิดการใช้งาน', m.updated_at = SYSDATETIME()
-- FROM   dbo.qcrd_menu m
-- WHERE  EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = m.menu_key)
--   AND  NOT EXISTS (SELECT 1 FROM dbo.qcrd_bom b WHERE b.menu_code = m.menu_code)
--   AND  NOT EXISTS (SELECT 1 FROM dbo.qcrd_bom b WHERE b.src_code  = m.menu_code)
--   AND  m.price IS NULL
--   AND  ISNULL(m.status, N'') <> N'ปิดการใช้งาน';

/* ===========================================================================
   5) กู้คืน ถ้าลบผิด (ตราบใดที่ยังไม่ได้ DROP ตารางสำรอง)
   =========================================================================== */
-- SET IDENTITY_INSERT dbo.qcrd_bom ON;   -- qcrd_bom.bom_id เป็น IDENTITY
-- INSERT INTO dbo.qcrd_menu SELECT * FROM dbo.qcrd_menu_backup_itemrows;
-- INSERT INTO dbo.qcrd_bom (bom_id, menu_code, menu_name, seq, item_code, item_key, item_name,
--        qty, converter, item_price, unit_cost, line_cost, src_code, src_name, src_factor,
--        src_base, tag, no_deduct, updated_at)
-- SELECT bom_id, menu_code, menu_name, seq, item_code, item_key, item_name,
--        qty, converter, item_price, unit_cost, line_cost, src_code, src_name, src_factor,
--        src_base, tag, no_deduct, updated_at
-- FROM dbo.qcrd_bom_backup_itemrows;
-- SET IDENTITY_INSERT dbo.qcrd_bom OFF;

/* ===========================================================================
   6) อย่าลืม — ลบแถวเดียวกันในชีท 'menu' ด้วย
      (ชีทต้นทุนเมนู 1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw แท็บแรก)
      ไม่งั้นครั้งหน้าที่รัน scripts\migrate-qcrd.ps1 หรือกด /api/qcrd-migrate
      MERGE จะดันแถวพวกนี้กลับเข้ามาใหม่ทั้งชุด แล้วต้องมานั่งลบซ้ำอีกรอบ
      รายชื่อที่ต้องลบในชีท: SELECT menu_code, menu_name FROM dbo.qcrd_menu_backup_itemrows;
   =========================================================================== */
