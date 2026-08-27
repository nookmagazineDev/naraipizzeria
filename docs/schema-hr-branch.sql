/* ============================================================================
   ทะเบียนสาขา (หน้า HR → จัดการสาขา) บน Microsoft SQL Server
   ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่ QC/RD และหน้านับสต๊อกใช้อยู่แล้ว

   ⚠️ ชื่อซ้ำกับตารางของอีกโปรเจกต์ — อ่านตรงนี้ก่อน
   ---------------------------------------------------------------------------
   มีตาราง dbo.hr_branch อยู่แล้วในฐาน **narai_hr** ซึ่งเป็นของโปรเจกต์ Narai-branch
   (ระบบลงตารางงานรายสัปดาห์) และเป็นตัวที่ office-server อ่านตอนตอบ action getBranches
   ให้ /api/hr-schedule ใช้ — ดูคอมเมนต์ที่ pages/api/hr-schedule.js:28

   ตารางในไฟล์นี้เป็น **คนละตัว** อยู่คนละฐาน:
       narai_hr.dbo.hr_branch        <- ของ Narai-branch (ระบบตารางงาน) ห้ามแก้จากที่นี่
       InventoryNarai.dbo.hr_branch  <- ตัวนี้ ทะเบียนที่หน้า HR ของแดชบอร์ดออฟฟิศแก้ได้

   ที่แยกกันเพราะการเขียนทับตารางของอีกโปรเจกต์เสี่ยงทำให้ระบบลงตารางงานของสาขาพัง
   ส่วนฐาน InventoryNarai นั้นแดชบอร์ดนี้เขียนตรงได้อยู่แล้ว (lib/qcrdPool.js)
   หน้า "จัดการสาขา" จึงมีปุ่มเทียบสองที่ให้เห็นว่ารหัสสาขาตรงกันไหม แทนที่จะปล่อยให้หลุดกันเงียบ ๆ

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-hr-branch.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute — รันซ้ำได้ ไม่พัง
   หรือกดปุ่ม "สร้างตาราง" ในหน้า HR → จัดการสาขา (ต้องให้ login มีสิทธิ์ db_ddladmin)

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) branch_code เป็นคีย์ เก็บเป็นตัวพิมพ์ใหญ่เสมอ (SJP ไม่ใช่ sjp) เพราะเครื่องสแกนหน้า
      ส่ง area_alias มาเป็นตัวพิมพ์ใหญ่ ส่วนฐาน HR เก็บตัวพิมพ์เล็ก — ฝั่งโค้ดเทียบแบบ
      ไม่สนตัวพิมพ์อยู่แล้ว แต่ในทะเบียนต้องมีตัวสะกดเดียวไม่งั้นจะมีสาขาซ้ำสองแถว
   2) outlet_id = รหัสร้านฝั่ง POS ยอมให้ NULL ได้ เพราะสาขาที่เพิ่งเปิดอาจยังไม่ได้เลขมา
      ตอนนี้เก็บไว้เป็นข้อมูลอ้างอิงของทะเบียน — ตารางแมป outlet ใน pages/api/*.js
      (usage, orderd, withdrawals, extra-orders, usagebytable, usage-bom, ai-chat, index)
      ยังเป็นชุด hardcode ของตัวเองอยู่ ยังไม่ได้ต่อเข้ากับทะเบียนนี้
   3) status ใช้คำไทยชุดเดียวกับหน้าวัตถุดิบของ QC/RD ('ใช้งาน' / 'ปิดการใช้งาน')
      จะเลิกใช้สาขาให้ตั้งเป็น 'ปิดการใช้งาน' อย่าลบแถว — ข้อมูลเก่า (ตารางงาน สแกนหน้า
      ค่าใช้จ่าย) ยังอ้างรหัสนั้นอยู่ ลบทิ้งแล้วรายงานย้อนหลังจะหาชื่อสาขาไม่เจอ
   4) sort_order = ลำดับที่อยากให้โผล่ใน dropdown ค่าเริ่มต้นเรียงตามลำดับเดิมที่เคย
      hardcode ไว้ (ไม่ได้เรียงตามตัวอักษรหรือตาม outlet_id)
   5) ทุกคอลัมน์ข้อความเป็น NVARCHAR เพราะชื่อสาขาเป็นภาษาไทย
============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE InventoryNarai;
GO

USE InventoryNarai;
GO

IF OBJECT_ID(N'dbo.hr_branch', N'U') IS NULL
CREATE TABLE dbo.hr_branch (
    branch_code NVARCHAR(10)   NOT NULL,   -- รหัสสาขา ตัวพิมพ์ใหญ่ (SJP, P90, ZK3)
    branch_name NVARCHAR(255)  NOT NULL CONSTRAINT DF_hr_branch_name    DEFAULT (N''),
    outlet_id   INT            NULL,       -- รหัสร้านฝั่ง POS (ว่างได้ถ้ายังไม่ได้เลขมา)
    status      NVARCHAR(30)   NOT NULL CONSTRAINT DF_hr_branch_status  DEFAULT (N'ใช้งาน'),
    note        NVARCHAR(500)  NOT NULL CONSTRAINT DF_hr_branch_note    DEFAULT (N''),
    sort_order  INT            NOT NULL CONSTRAINT DF_hr_branch_sort    DEFAULT (0),
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_hr_branch_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_branch PRIMARY KEY (branch_code)
);
GO

/* outlet_id ต้องไม่ซ้ำกัน — สองสาขาชี้ร้าน POS เดียวกันแปลว่ากรอกผิด แล้วยอดขายจะรวมมั่ว
   ใช้ filtered index เพื่อให้ NULL ซ้ำกันได้ (สาขาที่ยังไม่ได้เลข POS มีได้หลายสาขา) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_hr_branch_outlet' AND object_id = OBJECT_ID(N'dbo.hr_branch'))
    CREATE UNIQUE INDEX UQ_hr_branch_outlet ON dbo.hr_branch (outlet_id) WHERE outlet_id IS NOT NULL;
GO

/* ============================ ข้อมูลตั้งต้น 21 สาขา ============================
   ชุดเดียวกับที่เคย hardcode ไว้ใน components/Attendance.jsx, QcRdItems.jsx,
   OtherExpense.jsx และตาราง OUTLETS ใน pages/index.js
   ชื่อไทยยังว่าง — ไปกรอกที่หน้า HR → จัดการสาขา (หรือกดปุ่มดึงชื่อจากระบบตารางงาน)

   MERGE ทำให้รันซ้ำได้: มีอยู่แล้วไม่แตะ (กันเขียนทับชื่อ/สถานะที่แก้ไว้จากหน้าเว็บ)
   ขาดไปค่อยเติม                                                                */
MERGE dbo.hr_branch AS t
USING (VALUES
    (N'SJP',   7,  1), (N'CRM',  12,  2), (N'XCM',  19,  3), (N'SLR',  37,  4),
    (N'SUM',  51,  5), (N'XUM',  59,  6), (N'SCS',  61,  7), (N'SMP',  63,  8),
    (N'XSB',  67,  9), (N'XHH',  72, 10), (N'HRS',  78, 11), (N'CLK',  79, 12),
    (N'P90',  80, 13), (N'HPS', 109, 14), (N'ZBW', 400, 15), (N'ZPT', 401, 16),
    (N'NPT', 500, 17), (N'WRM', 501, 18), (N'WMT', 503, 19), (N'IPR', 904, 20),
    (N'ZK3', 906, 21)
) AS s (branch_code, outlet_id, sort_order)
ON t.branch_code = s.branch_code
WHEN NOT MATCHED BY TARGET THEN
    INSERT (branch_code, branch_name, outlet_id, status, note, sort_order)
    VALUES (s.branch_code, N'', s.outlet_id, N'ใช้งาน', N'', s.sort_order);
GO

/* ===================== ให้สิทธิ์ login ที่แดชบอร์ดใช้ต่อเข้ามา =====================
   ตัวเดียวกับที่ QC/RD ใช้ — ถ้ารัน docs/schema-qcrd.sql ไปแล้วก็ได้สิทธิ์ครบอยู่แล้ว
   ข้ามส่วนนี้ได้ แก้ @login ให้ตรงกับ QCRD_DB_USER (หรือ ZK_DB_USER / HR_DB_USER) ก่อนรัน */
DECLARE @login SYSNAME = N'narai_app';
DECLARE @sql NVARCHAR(MAX);

BEGIN TRY
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @login)
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @login)
        BEGIN
            SET @sql = N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login);
            EXEC sys.sp_executesql @sql;
        END
        SET @sql = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@login);
        EXEC sys.sp_executesql @sql;
        SET @sql = N'ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@login);
        EXEC sys.sp_executesql @sql;
        PRINT N'ให้สิทธิ์ ' + @login + N' ในฐานนี้เรียบร้อย';
    END
    ELSE
        PRINT N'ข้ามการให้สิทธิ์: ไม่พบ login ' + @login + N' บนอินสแตนซ์นี้ (แก้ตัวแปร @login ให้ตรงก่อน)';
END TRY
BEGIN CATCH
    PRINT N'ข้ามการให้สิทธิ์ (ผู้รันไม่มีสิทธิ์แจกสิทธิ์): ' + ERROR_MESSAGE();
END CATCH
GO

PRINT N'สร้างตารางทะเบียนสาขา (InventoryNarai.dbo.hr_branch) + ข้อมูลตั้งต้น 21 สาขา เรียบร้อย';
GO
