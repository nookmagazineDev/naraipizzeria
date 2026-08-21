/* ============================================================================
   QC/RD (เมนู · สูตร BOM · วัตถุดิบ · หมวดหมู่เมนู) บน Microsoft SQL Server
   ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่หน้านับสต๊อกใช้อยู่แล้ว (dbo.stock_*)

   ที่มา: ย้ายมาจากชีทต้นทุนเมนู 1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw
     ชีท 'menu'          -> dbo.qcrd_menu
     ชีท 'BOM'           -> dbo.qcrd_bom
     ชีท 'menucodegroup' -> dbo.qcrd_menu_group
     ชีท 'item'          -> dbo.stock_item + dbo.stock_item_branch (มีอยู่แล้ว)
                            + คอลัมน์ที่ QC/RD ใช้แต่ฝั่งสต๊อกยังไม่ได้เก็บ (เพิ่มท้ายไฟล์นี้)

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-qcrd.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute — รันซ้ำได้ ไม่พัง

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) ตารางสต๊อกใช้ item_key (รหัสที่ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) เป็นคีย์ทุกจุด
      ตาราง QC/RD ทำแบบเดียวกัน เพราะรหัสในชีทเขียนไม่ตรงกัน ('00123' กับ '123')
      ถ้าจับคู่ด้วยรหัสดิบจะหลุดเป็นพันรายการโดยไม่มีอะไรฟ้อง
      qcrd_bom.item_key จึงแทนคอลัมน์ I ของชีท (รหัสวัตถุดิบที่ตัด 0 นำหน้า) ไปในตัว
   2) คอลัมน์ G (ค่าคงที่ 1) และ L (ว่าง) ของชีท BOM ไม่ได้ย้ายมา — ไม่มีใครอ่าน
      ส่วน K กับ M ในชีทเป็นค่าเดียวกัน (ต้นทุน/หน่วยเล็ก) เก็บเป็น unit_cost ช่องเดียว
   3) ต้นทุน (qcrd_menu.cost, qcrd_bom.unit_cost/line_cost) เก็บเป็นค่าที่คำนวณไว้แล้ว
      เหมือนที่ Apps Script เขียนลงชีท ไม่ได้ทำเป็นคอลัมน์คำนวณ (computed column)
      เพราะราคาวัตถุดิบเปลี่ยนทีหลังได้ แล้วต้นทุนของสูตรเก่าต้องไม่ขยับเองเงียบ ๆ
      ฝั่ง API คิดใหม่ให้ทุกครั้งที่บันทึกสูตร (เหมือน saveMenu_ ใน qcrd-apps-script.gs)
   4) sort_order = ลำดับแถวในชีทเดิม หน้าเว็บเรียงเมนูตามลำดับนี้ ไม่ได้เรียงตามรหัส
      และ sortBom ก็ใช้ลำดับเมนูชุดนี้เป็นตัวตั้ง — ถ้าไม่เก็บไว้ ลำดับที่หน้าเว็บเห็นจะเพี้ยน
   5) ทุกคอลัมน์ข้อความเป็น NVARCHAR เพราะข้อมูลเป็นภาษาไทย
============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE InventoryNarai;
GO

USE InventoryNarai;
GO

/* ========================= หมวดหมู่เมนู (menucodegroup) =========================
   ชีท 'menucodegroup': A=รหัสหมวด B=ชื่อหมวด
   หน้า QC/RD ใช้เป็นตัวเลือกตอนเพิ่ม/แก้ไขเมนู และเพิ่มหมวดใหม่ได้จากในฟอร์ม */
IF OBJECT_ID(N'dbo.qcrd_menu_group', N'U') IS NULL
CREATE TABLE dbo.qcrd_menu_group (
    group_code  NVARCHAR(50)   NOT NULL,   -- A (MenuCode)
    group_name  NVARCHAR(255)  NOT NULL,   -- B
    sort_order  INT            NOT NULL CONSTRAINT DF_qcrd_menu_group_sort DEFAULT (0),
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_qcrd_menu_group_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_qcrd_menu_group PRIMARY KEY (group_code)
);
GO

/* ================================ เมนู (menu) ================================
   ชีท 'menu': A=Code B=NameThai C=MenuCode D=UnitPrice E=cost Menu
               F=สถานะ G=ปริมาณที่ได้ H=หน่วยที่ได้
   คีย์เป็นรหัสเมนูตามที่พิมพ์ (menu_code) เพราะหน้าเว็บอ้างด้วยรหัสนี้ตรง ๆ
   ส่วน menu_key (รหัสที่ normalize แล้ว) ไว้จับคู่กับเลขไอเทมที่ POS ส่งมาในหน้ายอดใช้ */
IF OBJECT_ID(N'dbo.qcrd_menu', N'U') IS NULL
CREATE TABLE dbo.qcrd_menu (
    menu_code   NVARCHAR(50)   NOT NULL,   -- A
    menu_key    NVARCHAR(50)   NOT NULL,   -- A ที่ตัด 0 นำหน้า + ตัวพิมพ์เล็ก
    menu_name   NVARCHAR(255)  NOT NULL,   -- B
    group_code  NVARCHAR(50)   NULL,       -- C (อ้าง qcrd_menu_group.group_code)
    price       DECIMAL(18,4)  NULL,       -- D ราคาขาย
    cost        DECIMAL(18,4)  NULL,       -- E ต้นทุนรวมจากสูตร (คิดใหม่ทุกครั้งที่บันทึก)
    status      NVARCHAR(50)   NULL,       -- F ว่าง/'ใช้งาน' = ใช้งาน, 'ปิดการใช้งาน' = ปิด
    yield_qty   DECIMAL(18,4)  NULL,       -- G ปริมาณที่ได้ต่อ 1 สูตร
    yield_unit  NVARCHAR(50)   NULL,       -- H หน่วยที่ได้
    sort_order  INT            NOT NULL CONSTRAINT DF_qcrd_menu_sort DEFAULT (0),
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_qcrd_menu_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_qcrd_menu PRIMARY KEY (menu_code)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qcrd_menu_key')
CREATE INDEX IX_qcrd_menu_key ON dbo.qcrd_menu (menu_key) INCLUDE (menu_name, cost);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qcrd_menu_group')
CREATE INDEX IX_qcrd_menu_group ON dbo.qcrd_menu (group_code) INCLUDE (menu_name);
GO

/* ============================== สูตรเมนู (BOM) ==============================
   ชีท 'BOM': A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัสวัตถุดิบ E=ชื่อวัตถุดิบ F=ยอดใช้
              G=1(ไม่ใช้) H=ตัวแปลงหน่วย I=รหัสตัด0นำหน้า J=ราคาวัตถุดิบ
              K,M=ต้นทุน/หน่วยเล็ก L=(ว่าง) N=ต้นทุนรวมของแถว
              O=รหัสเมนูต้นทาง P=ชื่อเมนูต้นทาง Q=สัดส่วนที่ดึงมา R=ยอดใช้ตามสูตรเดิม
              S=แท็ก T=ไม่ตัด BOM

   หนึ่งแถว = วัตถุดิบหนึ่งบรรทัดในสูตรของเมนูหนึ่ง
   ยอดใช้ (qty) เป็น "หน่วยเล็ก" ต่อ 1 จาน — หารด้วย converter ถึงจะเป็นหน่วยซื้อ
   (สูตรเดียวกับ /api/usage-bom: ใช้ไป = จำนวนที่ขาย × qty ÷ converter) */
IF OBJECT_ID(N'dbo.qcrd_bom', N'U') IS NULL
CREATE TABLE dbo.qcrd_bom (
    bom_id      BIGINT         IDENTITY(1,1) NOT NULL,
    menu_code   NVARCHAR(50)   NOT NULL,   -- A
    menu_name   NVARCHAR(255)  NULL,       -- B (เก็บไว้ให้ตรงกับชีท ตอนอ่านใช้ชื่อจาก qcrd_menu)
    seq         INT            NOT NULL,   -- C ลำดับวัตถุดิบในสูตร
    item_code   NVARCHAR(50)   NOT NULL,   -- D รหัสตามที่พิมพ์
    item_key    NVARCHAR(50)   NOT NULL,   -- I รหัสที่ normalize แล้ว (ใช้จับคู่กับ stock_item)
    item_name   NVARCHAR(255)  NULL,       -- E
    qty         DECIMAL(18,6)  NOT NULL,   -- F ยอดใช้ต่อ 1 จาน (หน่วยเล็ก)
    converter   DECIMAL(18,4)  NULL,       -- H หน่วยเล็กต่อ 1 หน่วยซื้อ (ว่าง = ใช้ 1000)
    item_price  DECIMAL(18,4)  NULL,       -- J ราคาต่อหน่วยซื้อ ณ ตอนบันทึกสูตร
    unit_cost   DECIMAL(18,8)  NULL,       -- K/M ต้นทุนต่อหน่วยเล็ก = item_price / converter
    line_cost   DECIMAL(18,8)  NULL,       -- N ต้นทุนของแถว = qty × unit_cost
    src_code    NVARCHAR(50)   NULL,       -- O ดึงสูตรมาจากเมนูไหน
    src_name    NVARCHAR(255)  NULL,       -- P
    src_factor  DECIMAL(18,6)  NULL,       -- Q สัดส่วนที่ดึงมา (0.2 = 20% ของสูตรต้นทาง)
    src_base    DECIMAL(18,6)  NULL,       -- R ยอดใช้ตามสูตรต้นทางก่อนคูณสัดส่วน
    tag         NVARCHAR(50)   NULL,       -- S แท็ก (วัตถุดิบ/แพ็กเกจจิ้ง)
    no_deduct   BIT            NOT NULL CONSTRAINT DF_qcrd_bom_no_deduct DEFAULT (0), -- T
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_qcrd_bom_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_qcrd_bom PRIMARY KEY (bom_id),
    -- ลำดับซ้ำในเมนูเดียวกันไม่ได้ — ฝั่งบันทึกลบสูตรเดิมทั้งชุดแล้วใส่ใหม่เรียง 1..n
    CONSTRAINT UQ_qcrd_bom_line UNIQUE (menu_code, seq)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qcrd_bom_menu')
CREATE INDEX IX_qcrd_bom_menu ON dbo.qcrd_bom (menu_code, seq)
    INCLUDE (item_key, item_code, item_name, qty, converter, no_deduct);
GO
/* "วัตถุดิบตัวนี้ถูกใช้ในเมนูไหนบ้าง" + หน้ายอดใช้ที่ไล่จากรหัสวัตถุดิบ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qcrd_bom_item')
CREATE INDEX IX_qcrd_bom_item ON dbo.qcrd_bom (item_key) INCLUDE (menu_code, qty, converter);
GO
/* เมนูที่ดึงสูตรมาจากเมนูอื่น — ใช้ตอน cascade คิดยอดใช้ใหม่เมื่อสูตรต้นทางเปลี่ยน */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qcrd_bom_src')
CREATE INDEX IX_qcrd_bom_src ON dbo.qcrd_bom (src_code) INCLUDE (menu_code, src_factor);
GO

/* ==================== คอลัมน์ที่ต้องเพิ่มใน dbo.stock_item ====================
   ชีท 'item' เป็นทะเบียนวัตถุดิบตัวเดียวกันทั้งฝั่งสต๊อกและฝั่ง QC/RD
   ตาราง stock_item ที่มีอยู่แล้วเก็บคอลัมน์ A,B,C,D,E,K,L,N (+ J ไปอยู่ stock_item_branch)
   แต่ยังไม่มี 6 ช่องที่หน้า QC/RD แก้ได้ — เพิ่มตรงนี้ ไม่ต้องสร้างตารางวัตถุดิบใหม่แยก
   (แยกตารางเมื่อไหร่ = ต้องคอยซิงก์ราคา/ชื่อสองที่ ซึ่งไม่มีวันตรงกันได้จริง)

   ⚠️ คอลัมน์ O ของชีทถูกใช้ชนกันอยู่ตอนนี้:
      - scripts/migrate-stock.mjs (Narai-branch) อ่าน O เป็น Plan (TRUE) -> stock_item.plan_only
      - qcrd-apps-script.gs เขียน O เป็น 'ประเภท' (วัตถุดิบ/แพ็กเกจจิ้ง)
      ใน SQL จึงแยกเป็นคนละคอลัมน์ (plan_only กับ item_type) แล้วจบปัญหาไปเลย
      ส่วนตอนย้ายข้อมูล scripts/migrate-qcrd.mjs จะดูค่าที่อยู่ในช่องนั้นว่าเป็นแบบไหน
      แล้วลงให้ถูกคอลัมน์ (TRUE/ture -> plan_only, วัตถุดิบ/แพ็กเกจจิ้ง -> item_type) */
/* ต้องมี stock_item อยู่ก่อน (มาจาก docs/schema-stock.sql ของรีโป Narai-branch)
   เช็กตรงนี้ก่อน ALTER เพื่อให้ได้ข้อความที่บอกวิธีแก้ ไม่ใช่ error ดิบว่าหาตารางไม่เจอ */
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NULL
    RAISERROR (N'ยังไม่มีตาราง dbo.stock_item — ต้องรัน docs/schema-stock.sql ของรีโป Narai-branch ก่อน', 16, 1);
GO

IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'converter') IS NULL
    ALTER TABLE dbo.stock_item ADD converter DECIMAL(18,4) NULL;   -- I หน่วยเล็กต่อ 1 หน่วยซื้อ
GO
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'sub_item1') IS NULL
    ALTER TABLE dbo.stock_item ADD sub_item1 NVARCHAR(50) NULL;    -- F ไอเทมทดแทน 1
GO
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'sub_item2') IS NULL
    ALTER TABLE dbo.stock_item ADD sub_item2 NVARCHAR(50) NULL;    -- G ไอเทมทดแทน 2
GO
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'sub_item3') IS NULL
    ALTER TABLE dbo.stock_item ADD sub_item3 NVARCHAR(50) NULL;    -- H ไอเทมทดแทน 3
GO
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'item_type') IS NULL
    ALTER TABLE dbo.stock_item ADD item_type NVARCHAR(50) NULL;    -- O ประเภท (วัตถุดิบ/แพ็กเกจจิ้ง)
GO
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.stock_item', N'used_when') IS NULL
    ALTER TABLE dbo.stock_item ADD used_when NVARCHAR(50) NULL;    -- P ใช้กับ (ทั้งสอง/ทานที่ร้าน/ห่อกลับบ้าน)
GO

/* ==================== สิทธิ์ของ login ที่เว็บ/API ใช้ ====================
   ฐานนี้ถูกเรียกใช้จากหลายทาง และแต่ละทางใช้ login คนละตัวได้:
     - Vercel ต่อ SQL ตรง   ใช้ QCRD_DB_USER หรือ ZK_DB_USER (ตัวเดียวกับหน้าสแกนหน้า) หรือ HR_DB_USER
     - host-server           ใช้ QCRD_DB_USER / DB_USER
   login พวกนี้ส่วนใหญ่มีสิทธิ์เฉพาะฐานของตัวเอง (เช่น ZKBio9) จึงต้องเพิ่ม user ในฐานนี้ให้ด้วย
   ไม่งั้นจะต่อติดแต่ query ไม่ผ่าน ขึ้นว่า 'The server principal ... is not able to access the database'

   แก้ @login ให้ตรงกับ login ที่ใช้จริง แล้วรันส่วนนี้ (รันซ้ำได้)
   db_ddladmin ใส่ไว้เพื่อให้สร้างตารางจากหน้าเว็บ (/api/qcrd-migrate?step=schema) ได้
   ถ้าไม่อยากให้สิทธิ์นั้น ก็รันไฟล์นี้ด้วย sa ที่เครื่องออฟฟิศครั้งเดียวแล้วข้าม step=schema ไป */
DECLARE @login SYSNAME = N'narai_web';   -- <<< แก้เป็นชื่อ login ที่ใช้จริง เช่น ZK_DB_USER ที่ตั้งบน Vercel

-- ครอบ TRY ไว้เพราะไฟล์นี้ถูกรันได้จากสองที่: ด้วย sa ที่เครื่องออฟฟิศ (ให้สิทธิ์ได้)
-- และจากหน้าเว็บผ่าน /api/qcrd-migrate?step=schema ซึ่งใช้ login ธรรมดาที่ให้สิทธิ์ตัวเองไม่ได้
-- ถ้าไม่ครอบไว้ ส่วนสร้างตารางที่สำเร็จไปแล้วจะถูกรายงานว่าล้มทั้งไฟล์เพราะบรรทัดนี้บรรทัดเดียว
BEGIN TRY
    IF SUSER_ID(@login) IS NOT NULL
    BEGIN
        IF DATABASE_PRINCIPAL_ID(@login) IS NULL
            EXEC(N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login));
        EXEC(N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@login));
        EXEC(N'ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@login));
        EXEC(N'ALTER ROLE db_ddladmin  ADD MEMBER ' + QUOTENAME(@login));
        PRINT N'ให้สิทธิ์ ' + @login + N' ในฐานนี้เรียบร้อย';
    END
    ELSE
        PRINT N'ข้ามการให้สิทธิ์: ไม่พบ login ' + @login + N' บนอินสแตนซ์นี้ (แก้ตัวแปร @login ให้ตรงก่อน)';
END TRY
BEGIN CATCH
    PRINT N'ข้ามการให้สิทธิ์ (ผู้รันไม่มีสิทธิ์แจกสิทธิ์): ' + ERROR_MESSAGE();
END CATCH
GO

PRINT N'สร้างตาราง QC/RD (qcrd_menu, qcrd_menu_group, qcrd_bom) + เพิ่มคอลัมน์ใน stock_item เรียบร้อย';
GO
