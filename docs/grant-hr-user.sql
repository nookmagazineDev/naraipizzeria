/* ============================================================================
   ให้แดชบอร์ดออฟฟิศจัดการ login ของสาขาได้ — สิทธิ์ข้ามฐาน
   ฐานข้อมูล narai_hr (ของโปรเจค Narai-branch / ระบบลงตารางงาน)

   ทำไมต้องมีไฟล์นี้
   ---------------------------------------------------------------------------
   บัญชีที่สาขาใช้ล็อกอินอยู่ในตาราง narai_hr.dbo.hr_user ซึ่งไม่มีหน้าจอจัดการเลย
   ต้องเปิด SSMS แล้ว UPDATE เอง — สภาพเดียวกับเป้ายอดสาขาก่อนที่จะย้ายมา
   ตอนนี้หน้า HR > login สาขา ของแดชบอร์ดออฟฟิศทำแทนได้แล้ว

   ⚠️ ไฟล์นี้ **ไม่ได้ย้ายตาราง** — ตารางยังอยู่ที่เดิม ระบบลงตารางงานยังอ่านเขียนตามปกติ
      แดชบอร์ดแค่ยิงถึงด้วยชื่อสามท่อน (narai_hr.dbo.hr_user) จากคอนเนกชันที่ชี้
      InventoryNarai อยู่แล้ว เพราะสองฐานอยู่บนอินสแตนซ์เดียวกัน
      (ดู Narai-branch/office-server/hr-db.js:6)

      จึงถอยกลับได้ทันทีโดยไม่ต้องย้ายข้อมูลอะไร — ดูหัวข้อ "ถอยกลับ" ท้ายไฟล์

   ⚠️ ให้เท่าที่ต้องใช้จริง: สี่สิทธิ์บนตารางเดียว **ไม่ใช่** db_datareader ทั้งฐาน
      ฐาน narai_hr มีตารางงาน ค่าแรงรายคน และประวัติการแก้ตารางอยู่ด้วย
      แดชบอร์ดไม่จำเป็นต้องเห็นของพวกนั้นเพื่อจัดการบัญชีล็อกอิน

   ⚠️ ไฟล์นี้เป็น UTF-8 (มี BOM) เหตุผลเต็ม ๆ อยู่หัว docs/schema-hr-branch.sql

   วิธีรัน (ที่เครื่องออฟฟิศ ด้วย sa หรือ login ที่แจกสิทธิ์ได้):
     sqlcmd -f 65001 -S localhost\\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\\grant-hr-user.sql

   แก้ @login ข้างล่างให้ตรงกับ QCRD_DB_USER ที่เครื่องออฟฟิศตั้งไว้ก่อนรัน
   (ค่าเริ่มต้น narai_app — ตัวเดียวกับที่ docs/schema-hr-branch.sql ใช้)

   ที่มา: docs/branch-hub.md
============================================================================ */

USE narai_hr;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

DECLARE @login SYSNAME = N'narai_app';
DECLARE @sql NVARCHAR(MAX);

IF DB_ID(N'narai_hr') IS NULL
BEGIN
    RAISERROR(N'ไม่พบฐาน narai_hr บนอินสแตนซ์นี้ — ไฟล์นี้ต้องรันที่เครื่องออฟฟิศเท่านั้น', 16, 1);
    RETURN;
END

IF OBJECT_ID(N'dbo.hr_user', N'U') IS NULL
BEGIN
    RAISERROR(N'ไม่พบตาราง narai_hr.dbo.hr_user — รัน Narai-branch/docs/schema-hr.sql ก่อน', 16, 1);
    RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @login)
BEGIN
    RAISERROR(N'ไม่พบ login ตัวนี้บนอินสแตนซ์ — แก้ตัวแปร @login ให้ตรงกับ QCRD_DB_USER ก่อน', 16, 1);
    RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @login)
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login);
    EXEC sys.sp_executesql @sql;
    PRINT N'สร้าง user ' + @login + N' ในฐาน narai_hr แล้ว';
END

/* สี่สิทธิ์บนตารางเดียว — ครบพอดีกับที่หน้า login สาขาทำได้:
     SELECT  แสดงรายชื่อบัญชี (ไม่เคยดึง password_hash ออกไป — ดู lib/branchUserSql.mjs)
     INSERT  เพิ่มบัญชีใหม่
     UPDATE  แก้สาขา/ชื่อที่แสดง/สถานะ และตั้งรหัสใหม่
     DELETE  ลบบัญชี (หน้าเว็บเชียร์ให้ปิดการใช้งานแทน แต่ปุ่มลบมีอยู่)
   ไม่ให้ ALTER / CREATE / สิทธิ์บนตารางอื่นในฐานนี้เลย */
SET @sql = N'GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_user TO ' + QUOTENAME(@login);
EXEC sys.sp_executesql @sql;
PRINT N'ให้สิทธิ์ ' + @login + N' บน narai_hr.dbo.hr_user เรียบร้อย';
GO

/* ============================ ตรวจผลหลังรัน ============================
   1) ได้สิทธิ์ครบสี่ตัวบนตารางเดียว และไม่มีตารางอื่นติดมา
        SELECT o.name AS table_name, p.permission_name
          FROM sys.database_permissions p
          JOIN sys.objects o ON o.object_id = p.major_id
          JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
         WHERE u.name = N'narai_app'
         ORDER BY o.name, p.permission_name;

   2) ⭐ สำคัญที่สุด — ทดสอบด้วย login จริงที่แดชบอร์ดใช้ ไม่ใช่ sa
      (sa มีสิทธิ์ทุกฐานอยู่แล้ว ทดสอบด้วย sa จะผ่านเสมอแม้ยังไม่ได้ให้สิทธิ์)
        USE InventoryNarai;
        EXECUTE AS USER = N'narai_app';
        SELECT TOP 5 username, branch, is_active FROM narai_hr.dbo.hr_user;
        REVERT;
      -- ต้องได้ข้อมูลออกมา ถ้าขึ้น "The SELECT permission was denied" แปลว่ายังไม่ครบ
      -- (ยิงจาก InventoryNarai โดยตั้งใจ เพราะนั่นคือฐานที่แดชบอร์ดต่ออยู่จริง)

   3) เปิดหน้า HR > login สาขา ต้องเห็นรายชื่อบัญชีขึ้นมา
============================================================================ */

/* ================================ ถอยกลับ ================================
   ไม่ได้ย้ายข้อมูลอะไร ถอนสิทธิ์อย่างเดียวก็จบ:

     USE narai_hr;
     REVOKE SELECT, INSERT, UPDATE, DELETE ON dbo.hr_user FROM narai_app;

   หน้า login สาขาจะขึ้นว่ามองไม่เห็นตาราง ส่วนระบบลงตารางงานไม่กระทบเลย
   เพราะใช้ login คนละตัว (narai_web) และไม่เคยพึ่งสิทธิ์ชุดนี้
============================================================================ */

PRINT N'แดชบอร์ดออฟฟิศจัดการ login ของสาขาได้แล้ว';
GO
