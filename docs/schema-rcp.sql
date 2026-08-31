/* ============================================================================
   สูตรฝั่ง POS (แท็บ RcpDtls) บน Microsoft SQL Server
   ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่ QC/RD, ทะเบียนสาขา และหน้านับสต๊อกใช้อยู่

   ที่มา: ชีท 1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg แท็บ RcpDtls
          (หรือไฟล์ Kios_Dtls.xlsx ที่ export ออกมาจากชีทเดียวกัน)
            คอลัมน์ A Lnk Salesitmid | B Rts Id | C Name | D Rts Seq
                     E Itm Code | F Itm Name | G Rts Netqty | H Rcp Qty | I Itm Rcpportion

   ใช้ทำอะไร: หน้า QC/RD > เมนู เอาสูตรชุดนี้มา "เติม" ให้เมนูที่ยังไม่มีสูตรในแท็บ BOM
              ของชีทต้นทุนเมนู — อ่านอย่างเดียว ไม่ใช่ตัวที่หน้าเว็บบันทึกทับ

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-rcp.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute — รันซ้ำได้ ไม่พัง
   แล้วค่อยนำเข้าข้อมูลด้วย  node scripts/migrate-rcp.mjs <ไฟล์.xlsx>

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) แยกเป็นหัวสูตร (rcp_recipe) กับบรรทัดวัตถุดิบ (rcp_line) เพราะ Rts Id -> Name
      เป็น 1:1 สะอาดอยู่แล้ว (ตรวจจากข้อมูลจริง 2,916 สูตร ไม่มี Rts Id ไหนมีชื่อเกินหนึ่งแบบ)
      เก็บรวมใบเดียวจะซ้ำชื่อ 15,168 รอบโดยไม่จำเป็น
   2) คีย์ของบรรทัดคือ (rts_id, line_no) ไม่ใช่ (rts_id, seq)
      เพราะข้อมูลจริงมี (Rts Id, Rts Seq) ซ้ำกันอยู่ 9 คู่ ถ้าเอา seq เป็นคีย์ ตัวนำเข้าจะทับกันเอง
      แล้วข้อมูลหายเงียบ ๆ — line_no คือลำดับแถวตามที่อ่านมาจากชีท ส่วน seq เก็บไว้แสดงผลตามเดิม
   3) name_key คือชื่อที่ตัดช่องว่าง/วงเล็บ/จุดคั่นออกแล้ว ใช้จับคู่กับชื่อเมนูในชีทต้นทุน
      **ต้องคิดด้วยสูตรเดียวกับ rcpNameKey ใน lib/rcpMatch.js เท่านั้น** ฝั่งไหนแก้ต้องแก้ให้ตรงกัน
      ที่ต้องตัดเพราะสองชีทสะกดไม่ตรงกันจริง (บ้างเว้นวรรคหลัง FC บ้างไม่เว้น วงเล็บคนละแบบ)
   4) name_loose ตัดวรรณยุกต์ออกอีกชั้น (ซีอิ้ว = ซีอิ๊ว, แพ็ค = แพ๊ค)
      เก็บไว้ "เสนอว่าน่าจะใช่ตัวไหน" เท่านั้น ห้ามเอาไปแปะสูตรอัตโนมัติ เพราะของคนละตัวชนกันได้
   5) ไม่ย้ายคอลัมน์ K–N ของชีท ('8.2', '@ calculate', '@ ที่ถูกต้อง', '@ ที่ใช้งาน')
      ทั้งชุดเป็นสูตร VLOOKUP ไปหาราคาในแท็บ 8.2 ไม่ใช่ข้อมูลต้นทาง — ในฐาน join เอาได้
      (คอลัมน์ '@ ที่ถูกต้อง' ว่างทั้งคอลัมน์อยู่แล้ว)
   6) ไม่ผูก foreign key ไป stock_item เพราะรหัสวัตถุดิบบางตัวในชีทนี้ไม่มีในทะเบียนสต๊อก
      (ชีทเองก็ยังขึ้น '8.2 ไม่มีข้อมูล' อยู่หลายร้อยแถว) ผูกไปจะนำเข้าไม่ผ่านทั้งก้อน
   ============================================================================ */

SET NOCOUNT ON;
GO

/* ---------- หัวสูตร ---------- */
IF OBJECT_ID('dbo.rcp_recipe', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.rcp_recipe (
        rts_id         INT            NOT NULL,   -- B  Rts Id — รหัสสูตรฝั่ง POS
        name           NVARCHAR(200)  NOT NULL,   -- C  Name — ชื่อสิ่งที่สูตรนี้ผลิต
        name_key       NVARCHAR(200)  NOT NULL,   -- คีย์จับคู่ (rcpNameKey)
        name_loose     NVARCHAR(200)  NOT NULL,   -- คีย์หลวม ไว้เสนอเท่านั้น (rcpNameKeyLoose)
        sales_item_id  INT            NULL,       -- A  Lnk Salesitmid (มีเฉพาะบางสูตร)
        line_count     INT            NOT NULL CONSTRAINT DF_rcp_recipe_lc DEFAULT (0),
        updated_at     DATETIME2(0)   NOT NULL CONSTRAINT DF_rcp_recipe_up DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_rcp_recipe PRIMARY KEY CLUSTERED (rts_id)
    );
END
GO

/* หาสูตรจากชื่อเมนู — ทางเข้าหลักของหน้า QC/RD (ไม่ unique เพราะชื่อซ้ำกันได้) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_rcp_recipe_name_key' AND object_id = OBJECT_ID('dbo.rcp_recipe'))
    CREATE INDEX IX_rcp_recipe_name_key ON dbo.rcp_recipe (name_key) INCLUDE (name, line_count);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_rcp_recipe_name_loose' AND object_id = OBJECT_ID('dbo.rcp_recipe'))
    CREATE INDEX IX_rcp_recipe_name_loose ON dbo.rcp_recipe (name_loose);
GO

/* ---------- บรรทัดวัตถุดิบ ---------- */
IF OBJECT_ID('dbo.rcp_line', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.rcp_line (
        rts_id     INT             NOT NULL,   -- B  อ้างกลับ rcp_recipe
        line_no    INT             NOT NULL,   -- ลำดับแถวตามชีท (ดูหมายเหตุ 2)
        seq        INT             NULL,       -- D  Rts Seq ตามที่ชีทเขียนไว้
        item_code  NVARCHAR(32)    NULL,       -- E  Itm Code (ตามที่พิมพ์ เช่น 01000077)
        item_key   NVARCHAR(32)    NULL,       -- E  ตัด 0 นำหน้าแล้ว ใช้ join กับ stock_item
        item_name  NVARCHAR(200)   NULL,       -- F  Itm Name
        net_qty    DECIMAL(18, 4)  NULL,       -- G  Rts Netqty (สูงสุดที่เจอจริง 80,000)
        rcp_qty    DECIMAL(18, 4)  NULL,       -- H  Rcp Qty
        portion    DECIMAL(18, 4)  NULL,       -- I  Itm Rcpportion (สูงสุดที่เจอจริง 25,000)
        CONSTRAINT PK_rcp_line PRIMARY KEY CLUSTERED (rts_id, line_no),
        CONSTRAINT FK_rcp_line_recipe FOREIGN KEY (rts_id)
            REFERENCES dbo.rcp_recipe (rts_id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_rcp_line_item_key' AND object_id = OBJECT_ID('dbo.rcp_line'))
    CREATE INDEX IX_rcp_line_item_key ON dbo.rcp_line (item_key);
GO

PRINT 'rcp_recipe / rcp_line พร้อมใช้งาน — นำเข้าข้อมูลด้วย node scripts/migrate-rcp.mjs <ไฟล์.xlsx>';
GO
