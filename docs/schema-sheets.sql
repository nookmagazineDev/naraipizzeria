/* ============================================================================
   ชีทที่เหลือ (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน)
   บน Microsoft SQL Server — ฐาน InventoryNarai
   เครื่องเดียวกับที่หน้า "ดูสแกนเข้างาน-ออกงาน" (ZKBio9) และตารางงาน (narai_hr) ใช้อยู่

   ที่มาของแต่ละตาราง
     ชีทสต๊อก 1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ
       แท็บ 'plan'              -> dbo.stock_plan
       แท็บ 'ปิดรอบสิ้นเดือน'    -> dbo.stock_closing
     ชีทค่าใช้จ่าย 1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw
       แท็บ 'ข้อมูลค่าใช้อื่น'   -> dbo.expense_ref
       แท็บ 'ค่าใช้จ่ายอื่น'     -> dbo.expense_entry
     (ชีทพนักงานย้ายไปฐาน narai_hr แล้ว — ดู docs/schema-hr-employee.sql)

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-sheets.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute — รันซ้ำได้ ไม่พัง
   (หรือกดจากเว็บ: /api/sheets-migrate?key=...&step=schema&confirm=1)

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) ใช้ item_key (รหัสที่ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) เป็นคีย์จับคู่เหมือน dbo.stock_item
      ทุกที่ เพราะรหัสในชีทเขียนไม่ตรงกัน ('00123' กับ '123') ถ้าจับด้วยรหัสดิบจะหลุดเงียบ ๆ
      ส่วน item_code เก็บรหัสตามที่พิมพ์ไว้ด้วย เผื่อต้องเทียบกลับกับชีทต้นทาง
   2) สาขาเก็บเป็นตัวพิมพ์เล็กทั้งหมด (branch) — ชีทเขียนปนกันทั้ง CRM/crm
      ฝั่งหน้าเว็บ /api/stock-closing เทียบด้วยตัวพิมพ์เล็กอยู่แล้ว
   3) วันที่เก็บเป็น DATE ไม่ใช่ข้อความ — ชีทเขียนปนกันทั้ง DD/MM/YYYY และ YYYY-MM-DD
      ตัวย้ายข้อมูลแปลงให้เป็น ISO ก่อนเขียนลงตาราง (ดู lib/sheetsMigrate.mjs)
   4) เดือนของค่าใช้จ่าย (period) เก็บเป็นข้อความ 'YYYY-MM' ตามที่ชีท/ฟอร์มใช้กันอยู่
      ไม่แปลงเป็นวันที่ เพราะฟอร์มกับปุ่ม Export อ้างเดือนด้วยข้อความตรง ๆ ทุกจุด
   5) ทุกคอลัมน์ข้อความเป็น NVARCHAR เพราะข้อมูลเป็นภาษาไทย
============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE InventoryNarai;
GO

USE InventoryNarai;
GO

/* ========================== แพลนสั่งของ (แท็บ plan) ==========================
   หนึ่งแถว = สินค้าหนึ่งบรรทัดในใบสั่งของสาขาหนึ่ง
   คอลัมน์ในชีท: วันที่สั่ง | เวลาบันทึก | สาขา | รหัสสาขา | เลขที่ใบสั่ง | ลำดับ |
                 วันที่รับ | itemId | รหัสสินค้า | ชื่อสินค้า | จำนวน | หน่วย |
                 ราคา/หน่วย | มูลค่ารวม | ประเภท | ผู้บันทึก

   คีย์เป็น (เลขที่ใบสั่ง, ลำดับ) — เป็นคู่ที่ชีทการันตีว่าไม่ซ้ำในใบเดียวกัน
   ทำให้ย้ายข้อมูลซ้ำกี่รอบก็ได้โดยไม่เกิดแถวซ้ำ (MERGE ทับของเดิม)
   ใบสั่งเก่าบางใบไม่มีเลขที่ ตัวย้ายจะสร้างให้เป็น '<สาขา><วันที่สั่ง>' แทน */
IF OBJECT_ID(N'dbo.stock_plan', N'U') IS NULL
CREATE TABLE dbo.stock_plan (
    order_no     NVARCHAR(60)   NOT NULL,   -- เลขที่ใบสั่ง
    seq          INT            NOT NULL,   -- ลำดับสินค้าในใบ
    order_date   DATE           NULL,       -- วันที่สั่ง
    record_time  NVARCHAR(20)   NULL,       -- เวลาบันทึก (HH:mm:ss ตามที่ชีทเก็บ)
    branch       NVARCHAR(20)   NOT NULL,   -- สาขา (ตัวพิมพ์เล็ก)
    outlet_id    NVARCHAR(20)   NULL,       -- รหัสสาขาฝั่ง POS
    receive_date DATE           NULL,       -- วันที่รับของ
    pos_item_id  NVARCHAR(50)   NULL,       -- itemId ฝั่ง POS
    item_code    NVARCHAR(50)   NULL,       -- รหัสสินค้าตามที่พิมพ์
    item_key     NVARCHAR(50)   NOT NULL,   -- รหัสที่ตัด 0 นำหน้า (จับคู่ stock_item)
    item_name    NVARCHAR(255)  NULL,
    qty          DECIMAL(18,4)  NULL,
    unit         NVARCHAR(50)   NULL,
    unit_price   DECIMAL(18,4)  NULL,
    total        DECIMAL(18,4)  NULL,
    order_type   NVARCHAR(50)   NULL,       -- ประเภท (สั่งปกติ/สั่งเพิ่ม ฯลฯ)
    recorded_by  NVARCHAR(100)  NULL,
    updated_at   DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_plan_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_plan PRIMARY KEY (order_no, seq)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_plan_branch_date')
CREATE INDEX IX_stock_plan_branch_date ON dbo.stock_plan (branch, order_date)
    INCLUDE (item_key, item_name, qty, total);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_plan_item')
CREATE INDEX IX_stock_plan_item ON dbo.stock_plan (item_key, order_date);
GO

/* ==================== ปิดรอบสิ้นเดือน (แท็บ ปิดรอบสิ้นเดือน) ====================
   ยอดคงเหลือที่ปิดไว้ตอนสิ้นเดือน — หน้านับสต๊อกเอาไปใช้เป็น "ยอดยกมา" ของรอบถัดไป
   คอลัมน์ในชีท: A วันที่ปิดยอด | B สาขา | C รหัสสินค้า | D ชื่อสินค้า | E หน่วย
                 F ยอดคงเหลือ | G มูลค่า/หน่วย | H มูลค่ารวม | I ผู้บันทึก | J เวลาบันทึก

   คีย์เป็น (วันที่ปิดยอด, สาขา, ไอเทม) — ปิดยอดวันเดียวกันซ้ำ = ทับของเดิม
   ตรงกับที่ /api/stock-closing ทำอยู่ (หยิบเฉพาะรายการล่าสุดของแต่ละไอเทม) */
IF OBJECT_ID(N'dbo.stock_closing', N'U') IS NULL
CREATE TABLE dbo.stock_closing (
    close_date   DATE           NOT NULL,   -- A วันที่ปิดยอด
    branch       NVARCHAR(20)   NOT NULL,   -- B (ตัวพิมพ์เล็ก)
    item_key     NVARCHAR(50)   NOT NULL,   -- C ที่ตัด 0 นำหน้า
    item_code    NVARCHAR(50)   NULL,       -- C ตามที่พิมพ์
    item_name    NVARCHAR(255)  NULL,       -- D
    unit         NVARCHAR(50)   NULL,       -- E
    balance      DECIMAL(18,4)  NOT NULL,   -- F ยอดคงเหลือสิ้นเดือน
    unit_value   DECIMAL(18,4)  NULL,       -- G มูลค่าต่อหน่วย
    total_value  DECIMAL(18,4)  NULL,       -- H มูลค่ารวม
    recorded_by  NVARCHAR(100)  NULL,       -- I
    recorded_at  NVARCHAR(30)   NULL,       -- J เวลาบันทึก (ข้อความตามชีท ใช้ตัดสินว่าแถวไหนใหม่กว่า)
    updated_at   DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_closing_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_closing PRIMARY KEY (close_date, branch, item_key)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_closing_branch')
CREATE INDEX IX_stock_closing_branch ON dbo.stock_closing (branch, close_date DESC)
    INCLUDE (item_key, balance, unit, recorded_at);
GO

/* =============== รหัสค่าใช้จ่าย (แท็บ ข้อมูลค่าใช้อื่น) ===============
   A=ประเภท (ไฟ/น้ำ/…) B=สาขา C=รหัส (เลขมิเตอร์/เลขที่ผู้ใช้บริการ)
   ฟอร์มหน้า "ค่าใช้จ่ายอื่นๆ" ใช้เป็นตัวเลือก — หนึ่งสาขามีได้หลายรหัสในประเภทเดียวกัน */
IF OBJECT_ID(N'dbo.expense_ref', N'U') IS NULL
CREATE TABLE dbo.expense_ref (
    ref_id      INT            IDENTITY(1,1) NOT NULL,
    exp_type    NVARCHAR(100)  NOT NULL,   -- A ประเภท
    branch      NVARCHAR(20)   NOT NULL,   -- B สาขา (ตัวพิมพ์ใหญ่ตามที่ชีทใช้)
    code        NVARCHAR(100)  NOT NULL CONSTRAINT DF_expense_ref_code DEFAULT (N''),  -- C รหัส
    sort_order  INT            NOT NULL CONSTRAINT DF_expense_ref_sort DEFAULT (0),
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_expense_ref_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_expense_ref PRIMARY KEY (ref_id),
    CONSTRAINT UQ_expense_ref UNIQUE (exp_type, branch, code)
);
GO

/* ============= ค่าใช้จ่ายอื่นๆ ที่บันทึกแล้ว (แท็บ ค่าใช้จ่ายอื่น) =============
   A=เดือน B=ประเภท C=สาขา D=รหัส E=เลขเริ่มต้น F=เลขสิ้นสุด
   G=จำนวน H=ราคา/หน่วย I=ผลรวม J=เวลาบันทึก/แก้ไข

   คีย์เป็น (เดือน, ประเภท, สาขา, รหัส) — ชุดเดียวกับที่ saveOtherExpense ใน
   Apps Script ใช้ตัดสินว่า "แถวเดิมมีอยู่แล้วให้เขียนทับ" จึงไม่เกิดแถวซ้ำเวลาแก้เดือนเดิม
   qty กับ total เก็บเป็นค่าที่คิดไว้แล้ว ไม่ได้ทำเป็นคอลัมน์คำนวณ เพราะบางแถวนำเข้า
   ยอดเงินรวมมาตรง ๆ โดยไม่มีเลขมิเตอร์ (buildRow_ ของ Apps Script ก็ทำแบบนี้) */
IF OBJECT_ID(N'dbo.expense_entry', N'U') IS NULL
CREATE TABLE dbo.expense_entry (
    period      NVARCHAR(7)    NOT NULL,   -- A เดือน 'YYYY-MM'
    exp_type    NVARCHAR(100)  NOT NULL,   -- B ประเภท
    branch      NVARCHAR(20)   NOT NULL,   -- C สาขา
    code        NVARCHAR(100)  NOT NULL CONSTRAINT DF_expense_entry_code DEFAULT (N''), -- D รหัส
    meter_start DECIMAL(18,4)  NULL,       -- E เลขเริ่มต้น
    meter_end   DECIMAL(18,4)  NULL,       -- F เลขสิ้นสุด
    qty         DECIMAL(18,4)  NULL,       -- G จำนวน = (F−E) × ตัวคูณหน่วยของสาขา
    unit_price  DECIMAL(18,4)  NULL,       -- H ราคาต่อหน่วย
    total       DECIMAL(18,4)  NULL,       -- I ผลรวม
    saved_at    NVARCHAR(30)   NULL,       -- J เวลาบันทึก/แก้ไขล่าสุด (ข้อความตามชีท)
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_expense_entry_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_expense_entry PRIMARY KEY (period, exp_type, branch, code)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_expense_entry_branch')
CREATE INDEX IX_expense_entry_branch ON dbo.expense_entry (branch, period)
    INCLUDE (exp_type, total);
GO

/* ========================= พนักงาน — ย้ายออกไปฐาน narai_hr แล้ว =========================
   ไฟล์นี้ไม่สร้าง dbo.hr_employee ให้อีก

   รายชื่อพนักงานเคยอยู่สองที่: InventoryNarai.dbo.hr_employee (ที่ไฟล์นี้เคยสร้าง) กับ
   narai_hr.dbo.hr_employee ที่ตารางงาน/กะ ของ Narai-branch ใช้อยู่ — สองที่แก้กันคนละรอบ
   ข้อมูลจึงเพี้ยนกัน รวมเหลือตารางเดียวที่ narai_hr ไปแล้ว เพราะประวัติกะผูกกับ hr_code
   ของฐานนั้น ย้ายกลับทางอื่นไม่ได้

     โครงตาราง + สคริปต์รวมข้อมูล -> docs/schema-hr-employee.sql
     ชื่อตารางที่โค้ดใช้             -> HR_EMPLOYEE_TABLE ใน lib/sheetsSql.mjs

   InventoryNarai.dbo.hr_employee ที่มีอยู่เดิมเหลือไว้เป็นสำเนาสำรอง ไม่มีใครอ่าน/เขียนแล้ว
   (ไม่ต้องลบ เก็บไว้เทียบย้อนหลังได้) */

/* ============================================================================
   ให้สิทธิ์ login ที่เว็บใช้ต่อเข้ามา (รันครั้งเดียว — ถ้าเคยรันตอน schema-qcrd.sql
   แล้วก็ข้ามได้ ตารางชุดนี้อยู่ในฐานเดียวกัน สิทธิ์ระดับฐานครอบคลุมให้อยู่แล้ว)
   เปลี่ยน <ชื่อ login> เป็นชื่อจริงที่ตั้งไว้ใน ZK_DB_USER / QCRD_DB_USER บน Vercel

   USE InventoryNarai;
   IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'<ชื่อ login>')
       CREATE USER [<ชื่อ login>] FOR LOGIN [<ชื่อ login>];
   ALTER ROLE db_datareader ADD MEMBER [<ชื่อ login>];
   ALTER ROLE db_datawriter ADD MEMBER [<ชื่อ login>];
   -- เพิ่มอันนี้ด้วยถ้าจะให้สร้างตารางจากหน้าเว็บได้ (step=schema)
   ALTER ROLE db_ddladmin  ADD MEMBER [<ชื่อ login>];
============================================================================ */
