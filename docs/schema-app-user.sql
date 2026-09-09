/* ============================================================================
   ผู้ใช้และสิทธิ์เมนู (หน้า ระบบ → จัดการผู้ใช้) บน Microsoft SQL Server
   ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่ QC/RD ทะเบียนสาขา และหน้านับสต๊อกใช้อยู่แล้ว

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-app-user.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute — รันซ้ำได้ ไม่พัง
   หรือกดปุ่ม "สร้างตาราง" ในหน้า ระบบ → จัดการผู้ใช้ (ต้องให้ login มีสิทธิ์ db_ddladmin)

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) username เป็นคีย์ เก็บเป็นตัวพิมพ์เล็กเสมอ (magazine ไม่ใช่ Magazine) เพราะคนกรอก
      ตอนล็อกอินจะพิมพ์มาแบบไหนก็ได้ — ฝั่งโค้ดแปลงเป็นตัวพิมพ์เล็กก่อนเทียบทุกครั้ง
      (lib/permissions.js → normalizeUsername) ในตารางจึงต้องมีตัวสะกดเดียว
   2) password_hash เก็บผลของ scrypt เป็นข้อความบรรทัดเดียว: scrypt$<N>$<salt>$<key>
      ไม่เก็บรหัสผ่านจริง และไม่มี API เส้นไหนคืนคอลัมน์นี้ออกไปให้หน้าเว็บ
      (lib/authUsers.js → hashPassword / verifyPassword)
   3) role มีสองค่า 'admin' กับ 'user'
      admin เห็นทุกเมนูเสมอโดยไม่ต้องไล่ติ๊ก และเป็นคนเดียวที่เข้าหน้าจัดการผู้ใช้ได้
      user เห็นเฉพาะคีย์เมนูที่อยู่ในคอลัมน์ perms
   4) perms เก็บ JSON array ของคีย์เมนู เช่น ["dashboard","sales","stockList"]
      คีย์ชุดเต็มอยู่ที่ lib/permissions.js (MENU_GROUPS) — เปิดเมนูใหม่ในหน้าเว็บ
      ต้องไปเติมที่ไฟล์นั้น ไม่ต้องแก้สคีมานี้
      เก็บเป็น NVARCHAR(MAX) ไม่ใช่ตาราง user_permission แยก เพราะสิทธิ์ชุดหนึ่งถูกอ่าน
      ทั้งก้อนเสมอ (ตอนล็อกอินครั้งเดียว) ไม่เคยถูก query ทีละคีย์ — แยกตารางมีแต่จะทำให้
      การบันทึกจากหน้าเว็บกลายเป็น delete+insert หลายแถวโดยไม่ได้อะไรกลับมา
   5) status ใช้คำไทยชุดเดียวกับทะเบียนสาขาและวัตถุดิบ QC/RD ('ใช้งาน' / 'ปิดการใช้งาน')
      จะเลิกใช้บัญชีให้ตั้งเป็น 'ปิดการใช้งาน' อย่าลบแถว — updated_by ของแถวอื่นยังอ้างชื่อนี้อยู่
      ⚠️ ตั๋วเข้าระบบที่ออกไปแล้วเรียกคืนไม่ได้ ปิดบัญชีตอนที่เขาล็อกอินค้างอยู่
      เขายังใช้ต่อได้จนตั๋วหมดอายุ (สูงสุด 12 ชม. — ดู SESSION_TTL_SECONDS ใน lib/authToken.js)
   6) branch_code ไว้ผูกบัญชีกับสาขา (เช่นบัญชีของผู้จัดการสาขา) ยังเป็นข้อมูลอ้างอิงเฉย ๆ
      ตอนนี้หน้าเว็บยังไม่ได้เอาไปกรองข้อมูล — คุมได้แค่ระดับ "เห็นเมนูไหน"
   7) ทุกคอลัมน์ข้อความเป็น NVARCHAR เพราะชื่อที่ใช้แสดงเป็นภาษาไทย
============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE InventoryNarai;
GO

USE InventoryNarai;
GO

IF OBJECT_ID(N'dbo.app_user', N'U') IS NULL
CREATE TABLE dbo.app_user (
    username      NVARCHAR(50)   NOT NULL,   -- ชื่อผู้ใช้ ตัวพิมพ์เล็ก (magazine, acc.somchai)
    display_name  NVARCHAR(255)  NOT NULL CONSTRAINT DF_app_user_display DEFAULT (N''),
    password_hash NVARCHAR(255)  NOT NULL CONSTRAINT DF_app_user_pwd     DEFAULT (N''),
    role          NVARCHAR(20)   NOT NULL CONSTRAINT DF_app_user_role    DEFAULT (N'user'),
    status        NVARCHAR(30)   NOT NULL CONSTRAINT DF_app_user_status  DEFAULT (N'ใช้งาน'),
    branch_code   NVARCHAR(10)   NOT NULL CONSTRAINT DF_app_user_branch  DEFAULT (N''),
    perms         NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_app_user_perms   DEFAULT (N'[]'),
    note          NVARCHAR(500)  NOT NULL CONSTRAINT DF_app_user_note    DEFAULT (N''),
    last_login_at DATETIME2(0)   NULL,
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_app_user_created DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_app_user_updated DEFAULT (SYSDATETIME()),
    updated_by    NVARCHAR(50)   NOT NULL CONSTRAINT DF_app_user_by      DEFAULT (N''),
    CONSTRAINT PK_app_user PRIMARY KEY (username),
    CONSTRAINT CK_app_user_role CHECK (role IN (N'admin', N'user'))
);
GO

/* ============================ บัญชีผู้ดูแลตั้งต้น ============================
   username: admin   รหัสผ่าน: admin1234

   ⚠️ เข้าครั้งแรกแล้วเปลี่ยนรหัสผ่านทันที (ปุ่ม "เปลี่ยนรหัสผ่าน" มุมขวาบน)
      รหัสตั้งต้นชุดนี้อยู่ในโค้ดที่เปิดอ่านได้ — ใครก็ตามที่เปิดหน้าเว็บนี้เจอจะเดาได้

   perms ของ admin เว้นเป็น [] ได้ เพราะฝั่งโค้ดให้ role='admin' เห็นทุกเมนูอยู่แล้ว
   (lib/permissions.js → hasPerm) แต่ใส่ครบไว้จะได้เห็นชุดคีย์เต็มเป็นตัวอย่าง

   MERGE ทำให้รันซ้ำได้: มีบัญชี admin อยู่แล้วไม่แตะ (กันเขียนทับรหัสที่เปลี่ยนไปแล้ว) */
MERGE dbo.app_user AS t
USING (VALUES (N'admin')) AS s (username)
ON t.username = s.username
WHEN NOT MATCHED BY TARGET THEN
    INSERT (username, display_name, password_hash, role, status, perms, note)
    VALUES (
        N'admin',
        N'ผู้ดูแลระบบ',
        N'scrypt$16384$d9e9fc32cd249cc3108e98d0108d8e94$e056539df5e8264202c875706e0fe98ba9a446d78294efdfa91ef7a019f8fdd1',
        N'admin',
        N'ใช้งาน',
        N'["dashboard","sales","dailySale","details","itemSearch","otherExpense","stockList","stockTotal","monthEnd","employeeList","attendance","salaryReport","branchList","qcrdMenu","qcrdItems","planList","branchRequisition","fcDashboard","fcReport","fcDaily","fcSales","fcDetail","fcExpense","aiNarai","userList"]',
        N'บัญชีตั้งต้น — เปลี่ยนรหัสผ่านทันทีหลังเข้าครั้งแรก'
    );
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

PRINT N'สร้างตารางผู้ใช้ (InventoryNarai.dbo.app_user) + บัญชี admin ตั้งต้นเรียบร้อย';
GO
