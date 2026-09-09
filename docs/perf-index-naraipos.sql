/* ============================================================================
   index ที่หน้ายอดขายต้องใช้ — NaraiPos (dbo.Ctrans / dbo.Cpaid)

   ที่มา: เครื่อง Narai-Pizzaria มี RAM 4 GB / SQL Express ใช้ cache ได้ 1.4 GB
   แต่ฐาน NaraiPos ใหญ่ 4.8 GB ทุก query ที่สแกนทั้งตารางจึงต้องอ่านดิสก์ทั้งก้อน
   กินเครื่องจนคำสั่งของหน้าอื่น (ดูสแกนหน้า / QC/RD) รอจน timeout ตามไปด้วย
   อาการที่เห็น: sys.dm_exec_requests ค้างที่ wait_type = PAGEIOLATCH_SH บน NaraiPos

   ทำไมถึงสแกนทั้งตาราง — index ที่มีอยู่ไม่ตรงกับคอลัมน์ที่ WHERE ใช้:
     /ctranbetweendate  กรองด้วย [PostTime]  แต่ index ที่มีคือ IX_Ctrans_StartTime
                        กับ IX_Ctrans_Outlet_StartTime (อยู่บน StartTime คนละคอลัมน์)
     /cpaidbetweendate  กรองด้วย [Date]      แต่ dbo.Cpaid มีแค่ PK_Cpaid
   (ดู host-server/server.js — route /ctranbetweendate และ /cpaidbetweendate)

   ⚠️ SQL Server Express สร้าง index แบบ ONLINE ไม่ได้ ตอนรันจะล็อกตารางไว้
      หลายนาที ให้รันตอนร้านปิด/ไม่มีคนใช้ POS

   วิธีรัน:
     sqlcmd -S localhost\SQLEXPRESS -E -d NaraiPos -i docs\perf-index-naraipos.sql
   ============================================================================ */
USE NaraiPos;
GO

/* ---- 1) dbo.Ctrans — รายการสินค้า กรองด้วย PostTime (+ OutletID ถ้าเลือกสาขา) ---- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('dbo.Ctrans') AND name = 'IX_Ctrans_PostTime_Outlet')
BEGIN
    PRINT 'สร้าง IX_Ctrans_PostTime_Outlet ...';
    CREATE NONCLUSTERED INDEX IX_Ctrans_PostTime_Outlet
        ON dbo.Ctrans ([PostTime], [OutletID]);
END
ELSE PRINT 'IX_Ctrans_PostTime_Outlet มีอยู่แล้ว ข้าม';
GO

/* ---- 2) dbo.Cpaid — รายบิล กรองด้วย Date (+ OutletID ถ้าเลือกสาขา) ---- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('dbo.Cpaid') AND name = 'IX_Cpaid_Date_Outlet')
BEGIN
    PRINT 'สร้าง IX_Cpaid_Date_Outlet ...';
    CREATE NONCLUSTERED INDEX IX_Cpaid_Date_Outlet
        ON dbo.Cpaid ([Date], [OutletID]);
END
ELSE PRINT 'IX_Cpaid_Date_Outlet มีอยู่แล้ว ข้าม';
GO

/* ---- 3) ตรวจผล: index ที่มีบนสองตารางนี้ ---- */
SELECT
    OBJECT_NAME(i.object_id) AS tbl,
    i.name                   AS idx,
    c.name                   AS col,
    ic.key_ordinal
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c        ON c.object_id  = i.object_id AND c.column_id = ic.column_id
WHERE i.object_id IN (OBJECT_ID('dbo.Ctrans'), OBJECT_ID('dbo.Cpaid'))
  AND ic.is_included_column = 0
ORDER BY tbl, idx, ic.key_ordinal;
GO
