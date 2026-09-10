/* ============================================================================
   หาสาเหตุที่ /cpaidbetweendate ช้า 125 วินาที (READ-ONLY ไม่แก้อะไร)

   รันที่ SSMS (เลือกฐาน NaraiPos) หรือ:
     sqlcmd -S localhost\SQLEXPRESS -E -d NaraiPos -i docs\check-slow-sales.sql
   ============================================================================ */
USE NaraiPos;
GO

/* ---- 1) ชนิดข้อมูลของคอลัมน์ที่ใช้กรอง ----
   ถ้า Date เป็น nvarchar แต่โค้ดส่ง VarChar มา = SQL ต้องแปลงชนิดที่ฝั่งคอลัมน์
   index ใช้ไม่ได้ทันที -> สแกนทั้งตาราง (แก้ที่โค้ดบรรทัดเดียว)                     */
SELECT 'Cpaid' AS tbl, c.name AS column_name, t.name AS data_type, c.max_length
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.Cpaid') AND c.name IN ('Date', 'OutletID')
UNION ALL
SELECT 'Ctrans', c.name, t.name, c.max_length
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.Ctrans') AND c.name IN ('PostTime', 'OutletID');
GO

/* ---- 2) ตารางใหญ่แค่ไหน ---- */
SELECT 'Cpaid' AS tbl, SUM(p.rows) AS n_rows
FROM sys.partitions p WHERE p.object_id = OBJECT_ID('dbo.Cpaid') AND p.index_id IN (0,1)
UNION ALL
SELECT 'Ctrans', SUM(p.rows)
FROM sys.partitions p WHERE p.object_id = OBJECT_ID('dbo.Ctrans') AND p.index_id IN (0,1);
GO

/* ---- 3) มี index อะไรอยู่บ้าง (ดูว่ามีตัวที่ขึ้นต้นด้วยคอลัมน์วันที่ไหม) ---- */
SELECT
    OBJECT_NAME(i.object_id) AS tbl,
    i.name AS index_name,
    i.type_desc,
    STUFF((SELECT ', ' + col.name
           FROM sys.index_columns ic
           JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
           WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           ORDER BY ic.key_ordinal
           FOR XML PATH('')), 1, 2, '') AS key_columns
FROM sys.indexes i
WHERE i.object_id IN (OBJECT_ID('dbo.Cpaid'), OBJECT_ID('dbo.Ctrans')) AND i.type > 0
ORDER BY tbl, i.index_id;
GO

/* ---- 4) จับเวลา query จริงที่ฝั่ง SQL ล้วน ๆ (ไม่ผ่าน API/เน็ต) ----
   ช้าตรงนี้ด้วย = ปัญหาอยู่ที่ฐาน ไม่ใช่เน็ตแน่นอน                                */
SET STATISTICS TIME ON;
SELECT COUNT(*) AS n
FROM dbo.Cpaid
WHERE [Date] >= '2026-09-09 00:00:00' AND [Date] <= '2026-09-09 23:59:59';
SET STATISTICS TIME OFF;
GO
