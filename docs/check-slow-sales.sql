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

/* ---- 5) สเปคเครื่อง + ข้อจำกัดของ SQL Server รุ่นที่ใช้ ----
   Express จำกัดแคชไว้ 1 GB · CPU 4 คอร์ · ฐานโตได้สูงสุด 10 GB
   ถ้าฐานใกล้ 10 GB ต้องวางแผนล่วงหน้า (เขียนไม่ได้เลยเมื่อเต็ม)                     */
SELECT
    SERVERPROPERTY('Edition')        AS edition,
    SERVERPROPERTY('ProductVersion') AS product_version;

SELECT cpu_count AS cpu_cores, physical_memory_kb / 1024 AS ram_mb
FROM sys.dm_os_sys_info;

/* ขนาดฐาน NaraiPos (data + log) — เทียบกับเพดาน 10 GB ของ Express ที่นับเฉพาะ data */
SELECT
    mf.name        AS file_name,
    mf.type_desc   AS file_type,
    mf.size * 8 / 1024 AS size_mb
FROM sys.master_files mf
WHERE mf.database_id = DB_ID('NaraiPos');

/* ตารางไหนกินที่มากสุดในฐานนี้ */
SELECT TOP 10
    OBJECT_NAME(p.object_id)      AS tbl,
    SUM(p.rows)                   AS n_rows,
    SUM(a.total_pages) * 8 / 1024 AS size_mb
FROM sys.partitions p
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE p.index_id IN (0, 1) AND OBJECTPROPERTY(p.object_id, 'IsUserTable') = 1
GROUP BY p.object_id
ORDER BY size_mb DESC;
GO
