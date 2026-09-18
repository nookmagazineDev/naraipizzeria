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

   ⚠️ ไฟล์นี้เป็น UTF-8 (มี BOM) — ห้ามบันทึกทับเป็น ANSI ไม่งั้น sqlcmd จะอ่านคำว่า
      N'ใช้งาน' ผิดตั้งแต่ตอนอ่านไฟล์ แล้วเขียนตัวอ่านไม่ออกลงฐานจริง ๆ
      (เคยเกิดมาแล้ว: สถานะทุกสาขาในทะเบียนกลายเป็น 'à¹ƒà¸Šà¹‰à¸‡à¸²à¸™')
      ไม่แน่ใจให้บังคับด้วย  sqlcmd -f 65001 ...

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
      ตอนนี้เก็บไว้เป็นข้อมูลอ้างอิงของทะเบียน — ตารางแมป outlet ในไฟล์ฝั่ง API
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

/* sqlcmd ตั้ง QUOTED_IDENTIFIER มาเป็น OFF (ต่างจาก SSMS ที่ ON ให้อยู่แล้ว) ซึ่งสร้าง
   filtered index (index ที่มี WHERE) ไม่ได้ — จะขึ้น Msg 1934 แล้วข้าม index ไปเงียบ ๆ
   ตั้งไว้ตรงนี้เป็น batch ของตัวเอง ค่าจะติดไปตลอดคอนเนกชัน ใช้ได้ทั้งสองทาง */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.hr_branch', N'U') IS NULL
CREATE TABLE dbo.hr_branch (
    branch_code NVARCHAR(10)   NOT NULL,   -- รหัสสาขา ตัวพิมพ์ใหญ่ (SJP, P90, IPR)
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

/* ============================ ข้อมูลตั้งต้น 20 สาขา ============================
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
    (N'P90',  80, 13), (N'HPS', 902, 14), (N'ZBW', 400, 15), (N'ZPT', 401, 16),
    (N'NPT', 500, 17), (N'WRM', 501, 18), (N'WMT', 503, 19), (N'IPR', 904, 20)
) AS s (branch_code, outlet_id, sort_order)
ON t.branch_code = s.branch_code
WHEN NOT MATCHED BY TARGET THEN
    INSERT (branch_code, branch_name, outlet_id, status, note, sort_order)
    VALUES (s.branch_code, N'', s.outlet_id, N'ใช้งาน', N'', s.sort_order);
GO

/* ===================== ซ่อมสถานะที่อ่านไม่ออกจากการรันด้วย ANSI =====================
   คอลัมน์ status มีได้แค่ 'ใช้งาน' กับ 'ปิดการใช้งาน' — ค่าอื่นคือของที่เขียนเพี้ยนมา
   ตอนรันไฟล์นี้ด้วย codepage ผิด ตั้งกลับเป็น 'ใช้งาน' ให้

   ⚠️ ถ้าสาขาไหนถูกปิดการใช้งานไว้แล้ว "และ" ค่านั้นเพี้ยนไปด้วย จะถูกตั้งกลับเป็นใช้งาน
      ต้องไปปิดใหม่ที่หน้า HR > จัดการสาขา — ตรวจรายการก่อนรันได้ด้วย
      SELECT branch_code, status FROM dbo.hr_branch;                                  */
DECLARE @fixed INT;
UPDATE dbo.hr_branch SET status = N'ใช้งาน'
WHERE status NOT IN (N'ใช้งาน', N'ปิดการใช้งาน');
SET @fixed = @@ROWCOUNT;
IF @fixed > 0 PRINT N'ซ่อมสถานะที่อ่านไม่ออก ' + CAST(@fixed AS NVARCHAR(10)) + N' สาขา';
GO

/* ===================== ช่องเพิ่มเติมของทะเบียน (Branch Hub) =====================
   เพิ่มทีหลัง ตอนที่ทะเบียนนี้ถูกยกให้เป็น "ทะเบียนแม่" ของทั้งสามระบบ
   (โปรเจคนี้ · ระบบตารางงาน Narai-branch · ระบบสโตร์ narai-storefct)
   เหตุผลและแผนทั้งหมดอยู่ใน docs/branch-hub.md

   ทุกช่องยอมให้ NULL ได้หมด จึงเติมลงตารางที่มีข้อมูลอยู่แล้วได้ทันที ไม่ล็อกนาน
   และโค้ดเวอร์ชันเก่าที่ยังไม่รู้จักช่องพวกนี้ก็ยังทำงานได้ตามปกติ                */
IF COL_LENGTH(N'dbo.hr_branch', N'opened_at')  IS NULL
    ALTER TABLE dbo.hr_branch ADD opened_at DATE NULL;
IF COL_LENGTH(N'dbo.hr_branch', N'closed_at')  IS NULL
    ALTER TABLE dbo.hr_branch ADD closed_at DATE NULL;
IF COL_LENGTH(N'dbo.hr_branch', N'region')     IS NULL
    ALTER TABLE dbo.hr_branch ADD region NVARCHAR(50) NOT NULL CONSTRAINT DF_hr_branch_region DEFAULT (N'');
IF COL_LENGTH(N'dbo.hr_branch', N'pos_db_key') IS NULL
    ALTER TABLE dbo.hr_branch ADD pos_db_key NVARCHAR(50) NULL;
GO

/* opened_at / closed_at มีไว้ให้รายงานย้อนหลังแยกออกว่า "ยอดเป็น 0 เพราะขายไม่ได้"
   กับ "ยอดเป็น 0 เพราะเดือนนั้นยังไม่เปิดสาขา/ปิดไปแล้ว" — สองอย่างนี้หน้าตาเหมือนกันเป๊ะ
   ในกราฟ แต่คนละเรื่องกันสิ้นเชิง ตอนนี้ยังไม่มีอะไรบอกความต่างได้เลย

   ปิดสาขายังคงใช้ status = N'ปิดการใช้งาน' เป็นตัวตัดสินเหมือนเดิม (โค้ดทุกที่อ่านช่องนั้น)
   closed_at เป็นแค่ "ปิดเมื่อไหร่" ไม่ใช่ "ปิดหรือยัง" — ห้ามเอาไปใช้แทนกัน            */

/* ===================== รหัสพ้อง: รหัสคนละตัวแต่เป็นร้านเดียวกัน =====================
   เคสจริง: เว็บล็อกอินด้วย zjp แต่ชีท/POS/เครื่องสแกนหน้าเขียนว่า SJP (ทั้งคู่คือ outlet 7)
   ล็อกอิน zjp แล้วรายชื่อพนักงานขึ้นไม่ครบ เพราะข้อมูลถูกบันทึกไว้ใต้รหัสอีกตัว

   ก่อนมีตารางนี้ กติกาเดียวกันนี้ถูกเขียนซ้ำไว้ 5 ที่ใน 3 โปรเจค และไม่มีอะไรบังคับให้ตรงกัน:
       naraipizzeria/lib/branchRegistry.js       ALIASES
       naraipizzeria/pages/api/usage.js          { 'zjp': 'sjp' }
       Narai-branch/src/utils/branchAlias.js     BRANCH_ALIAS_GROUPS
       Narai-branch/office-server/hr-session.js  BRANCH_ALIAS_GROUPS (ไฟล์เตือนเองว่า "ต้องแก้ทั้งสองที่")
       narai-storefct/lib/branches.js            ALIASES
   เพิ่มคู่ใหม่แล้วลืมที่ใดที่หนึ่ง = อาการ "ข้อมูลขึ้นไม่ครบ" ที่เงียบมากและหายาก

   ⚠️ alias ต้องไม่ซ้ำกับ branch_code ที่มีอยู่จริง — ไม่งั้นรหัสจริงจะถูกแปลไปเป็นสาขาอื่น
      ฐานบังคับให้ไม่ได้ (คนละตาราง) ตัวตรวจอยู่ฝั่งโค้ดใน lib/branchSql.mjs      */
IF OBJECT_ID(N'dbo.hr_branch_alias', N'U') IS NULL
CREATE TABLE dbo.hr_branch_alias (
    alias       NVARCHAR(20)  NOT NULL,   -- รหัสพ้อง ตัวพิมพ์ใหญ่ (ZJP)
    branch_code NVARCHAR(10)  NOT NULL,   -- ชี้ไปสาขาจริงในทะเบียน (SJP)
    source      NVARCHAR(50)  NOT NULL CONSTRAINT DF_hr_branch_alias_source DEFAULT (N''),
    note        NVARCHAR(255) NOT NULL CONSTRAINT DF_hr_branch_alias_note   DEFAULT (N''),
    updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_branch_alias_upd    DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_branch_alias PRIMARY KEY (alias),
    CONSTRAINT FK_hr_branch_alias_branch FOREIGN KEY (branch_code)
        REFERENCES dbo.hr_branch (branch_code)
);
GO

/* source = รหัสนี้มาจากระบบไหน ('login' / 'pos' / 'zkbio' / 'sheet')
   มีไว้เพราะคนที่มาอ่านทีหลังต้องตอบให้ได้ว่า "ลบทิ้งได้หรือยัง" — รหัสพ้องที่มาจากชีท
   เลิกใช้ได้เมื่อชีทเลิกใช้ ส่วนรหัสที่มาจากหน้าล็อกอินลบไม่ได้จนกว่าคนจะเลิกใช้รหัสนั้นล็อกอิน */
MERGE dbo.hr_branch_alias AS t
USING (VALUES
    (N'ZJP', N'SJP', N'login', N'เว็บล็อกอินด้วย zjp แต่ชีท/POS/เครื่องสแกนหน้าเขียนว่า SJP'),
    (N'ZIP', N'CRM', N'pos',   N'เคยฝังไว้ใน usage.js และ usagebytable.js — ข้อมูลเก่าบางชุดยังเขียนมาแบบนี้')
) AS s (alias, branch_code, source, note)
ON t.alias = s.alias
WHEN NOT MATCHED BY TARGET
     -- สาขาปลายทางต้องมีอยู่จริงก่อน ไม่งั้น FK จะเตะทั้ง batch ทิ้ง
     AND EXISTS (SELECT 1 FROM dbo.hr_branch b WHERE b.branch_code = s.branch_code) THEN
    INSERT (alias, branch_code, source, note)
    VALUES (s.alias, s.branch_code, s.source, s.note);
GO

/* ===================== เป้ายอดขายและเพดานค่าแรงรายสาขา =====================
   ย้ายมาจาก narai_hr.dbo.hr_branch (โปรเจค Narai-branch) ซึ่งเดิมไม่มีหน้าจอให้แก้เลย
   ต้องเปิด SSMS แล้ว UPDATE เอง (ดู docs/hr-sql-migration.md ของโปรเจคนั้น)
   ย้ายมาที่นี่แล้วแก้จากหน้า HR > จัดการสาขา ได้ ส่วนฝั่งตารางงานอ่านกลับไปผ่าน view
   ที่ join สองตารางนี้เข้าด้วยกัน — ดูขั้นตอนใน docs/migrate-branch-hub.sql

   ⚠️ แยกตาราง ไม่รวมเข้า hr_branch เพราะเป็นของที่เปลี่ยนคนละจังหวะและคนละคนแก้
      ทะเบียน = งานเปิดสาขา (ปีละไม่กี่ครั้ง) · เป้า/เพดานค่าแรง = งานรายเดือน
      แยกไว้แล้วให้สิทธิ์แก้คนละชุดได้ และ updated_at ของสองเรื่องไม่ปนกัน       */
IF OBJECT_ID(N'dbo.hr_branch_target', N'U') IS NULL
CREATE TABLE dbo.hr_branch_target (
    branch_code    NVARCHAR(10)  NOT NULL,
    daily_target   DECIMAL(14,2) NOT NULL CONSTRAINT DF_hr_branch_target_daily   DEFAULT (0),
    monthly_target DECIMAL(14,2) NOT NULL CONSTRAINT DF_hr_branch_target_monthly DEFAULT (0),
    max_wage       DECIMAL(14,2) NOT NULL CONSTRAINT DF_hr_branch_target_wage    DEFAULT (0),
    updated_at     DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_branch_target_upd     DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_branch_target PRIMARY KEY (branch_code),
    CONSTRAINT FK_hr_branch_target_branch FOREIGN KEY (branch_code)
        REFERENCES dbo.hr_branch (branch_code)
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

PRINT N'สร้างตารางทะเบียนสาขา (InventoryNarai.dbo.hr_branch) + ข้อมูลตั้งต้น 20 สาขา เรียบร้อย';
GO
