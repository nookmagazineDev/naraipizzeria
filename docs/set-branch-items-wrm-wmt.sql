/* ============================================================================
   ตั้งรายการวัตถุดิบของสาขา WRM และ WMT ให้ตรงกับไฟล์ wakame.xlsx
   (ไม่แตะวัตถุดิบหมวดอุปกรณ์ ปล่อยไว้ตามเดิม)

   ข้อมูลเก็บที่ไหน
   ---------------------------------------------------------------------------
   ช่อง "สาขาที่ใช้" ในหน้าวัตถุดิบ QC/RD = ตาราง dbo.stock_item_branch
   (แถวละคู่ item_key + branch ตัวพิมพ์เล็ก ดู lib/qcrdSql.mjs readItems/writeItemBranches)
   item_key = รหัสสินค้าที่ตัดเลข 0 ข้างหน้าออก (normCode) เช่น 02000022 -> 2000022

   สคริปต์นี้ทำอะไร
   ---------------------------------------------------------------------------
     - รหัส 0 ตัวในไฟล์ (ทุกหัวข้อ ยกเว้น "เฉพาะเมืองทอง") -> ใช้ทั้ง WRM และ WMT
     - รหัส 164 ตัวในหัวข้อ "เฉพาะเมืองทอง"                   -> ใช้เฉพาะ WMT
     - วัตถุดิบที่ WRM/WMT ใช้อยู่ แต่ไม่อยู่ในรายการ          -> เอาสาขานั้นออก
     - วัตถุดิบที่ ประเภท (item_type) หรือ หมวดสโตร์ (store_cat) มีคำว่า "อุปกรณ์"
       ไม่เพิ่ม ไม่ลบ คงไว้ตามเดิมทั้งหมด
     - สาขาอื่นไม่ถูกแตะเลย

   วิธีรัน (SSMS บนเครื่องออฟฟิศ เลือกฐาน InventoryNarai)
   ---------------------------------------------------------------------------
     1) รันทั้งไฟล์ตามที่เป็นอยู่ (@apply = 0) = ดูอย่างเดียว ไม่เปลี่ยนข้อมูล
        ได้ผล 4 ตาราง:
          ก. รหัสในไฟล์ที่ไม่พบในทะเบียนวัตถุดิบ (ต้องไปเพิ่มในหน้าวัตถุดิบก่อน
             ไม่งั้นรหัสพวกนี้จะไม่ถูกผูกกับสาขา)
          ข. รหัสในไฟล์ที่เป็นหมวดอุปกรณ์ (ข้ามไป ไม่แตะ)
          ค. สรุปต่อสาขา: มีอยู่ตอนนี้ / จะเพิ่ม / จะเอาออก / อุปกรณ์ที่คงไว้ / หลังแก้
          ง. รายการที่จะเพิ่ม/เอาออกทีละตัว
     2) ตรวจผลให้เรียบร้อย แล้วแก้บรรทัด  SET @apply = 0  เป็น  1  แล้วรันอีกรอบ
        -> สำรองข้อมูลเดิมของ WRM/WMT ไว้ที่ dbo.stock_item_branch_bak_wrm_wmt
           แล้วแก้จริงในทรานแซกชันเดียว (พังกลางทาง = ย้อนทั้งหมด)

   ย้อนกลับ (ถ้าจำเป็น) — ใช้ข้อมูลสำรองรอบล่าสุด:
     BEGIN TRAN;
     DELETE FROM dbo.stock_item_branch WHERE LOWER(branch) IN (N'wrm', N'wmt');
     INSERT INTO dbo.stock_item_branch (item_key, branch)
       SELECT item_key, branch FROM dbo.stock_item_branch_bak_wrm_wmt
       WHERE backup_at = (SELECT MAX(backup_at) FROM dbo.stock_item_branch_bak_wrm_wmt);
     COMMIT;

   ⚠️ ก่อนรัน
     - หน้าเว็บต้องอ่านวัตถุดิบจาก SQL (env QCRD_SOURCE=sql) ถ้ายังอ่านจากชีท 'item'
       แก้ใน SQL แล้วหน้าเว็บจะไม่เปลี่ยน
     - อย่ากด /api/qcrd-migrate หรือรัน scripts/migrate-qcrd หลังจากนี้ ถ้าชีทยังเป็นค่าเก่า
       เพราะตัว migrate จะเขียน "สาขาที่ใช้" ทับจากชีทกลับมาเหมือนเดิม (lib/qcrdMigrate.mjs itemBranchStmt)
   ============================================================================ */
USE InventoryNarai;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply BIT;
SET @apply = 0;   -- 0 = ดูอย่างเดียว · 1 = แก้จริง

/* ---- รายการจากไฟล์ wakame.xlsx ----
   grp: both = WRM + WMT · wmt = เฉพาะเมืองทอง */
DECLARE @src TABLE (grp NVARCHAR(10), code NVARCHAR(50), item_key NVARCHAR(50), name NVARCHAR(300));
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000022', N'2000022', N'FC เพตโต้ราเมน (300กรัม/ถุง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000013', N'11000013', N'สเต็กแฮม(บีลัคกี้ 50-55 pcs/กก)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050089', N'11050089', N'เนยสดจืดก้อนเล็ก(8G/ก้อน10/แพ็ค)ก้อน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000603', N'11000603', N'ผงปรุงรสซาวครีมหัวหอมโดนัท(200กรัม)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'31000062', N'31000062', N'พวงกุญแจคริสต์มาส');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'31000052', N'31000052', N'ถุงผ้าดิบ#9252หนา8OZ.หูหิ้วสายในตัว32X35X6CM.OKC05');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000347', N'11000347', N'ข้าวโพดเม็ดFZ(1กก/10แพ็ค/กล่อง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000203', N'11000203', N'เฟรนฟรายEXTRA CRISPY(1กก./10ถุง/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050007', N'11050007', N'ไข่กุ้งส้ม SAKO 500 กรัม');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050013', N'11050013', N'เกี๊ยวซ่าไส้หมูผสมไก่(15g/80ชิ้น/แพ็ค6/ลัง)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050037', N'11050037', N'ทาโกะยากิ(50ลูก/แพ็ค10/500ลูก/ลัง)ลูก');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050102', N'11050102', N'ทงคัตสึ(100กรัม/ชิ้น4/แพ็ค10/ลัง)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050096', N'11050096', N'กุ้งชุบแป้งเทม(10ชิ้น/แพ็ค/25G.)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050071', N'11050071', N'นารูโตะ(120กรัม/แท่ง)แท่ง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000036', N'2000036', N'FC เนื้อออสสไลซ์ 80-85g/ที่ (5ที่/แพ็ค)ที่');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'01000008', N'1000008', N'FCเนยกระเทียม (1ถุง/1กก) กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000086', N'2000086', N'FCน้ำมันกระเทียมเจียวดำ(200กรัม/ถุง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'01000177', N'1000177', N'FCเพส์ทน้ำซุปต้มยำ (1.4กก./ถุง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'01000178', N'1000178', N'FCเพส์ทน้ำซุปทงคตสึ(0.5กก./ถุง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000009', N'2000009', N'FC น้ำมันงาเผ็ด (1กก./แพ๊ค) กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000012', N'2000012', N'FCเพส์ทสุกี้ญีปุ่น 1.1กก./แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000016', N'2000016', N'FCเพส์ทมิโสะ (1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000017', N'2000017', N'FC ไก่หมักคาราเกะ (1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000018', N'2000018', N'FC หมูสามชั้นชาชู (30ชิ้น /แพ๊ค)แพ๊ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000076', N'2000076', N'FC หมูผัดน้ำมันพริก(สูตรปรับ) 1 กก./ถุง (กก.)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000049', N'2000049', N'FC สไปซี่มิโสะ 0.3กรัม/ถุง (ถุง)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000051', N'2000051', N'FC น้ำส้มสายชูMIZKAN(1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000064', N'2000064', N'FC หัวปลาแซลมอนต้มซีอิ๊ว/ที่');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11010047', N'11010047', N'IN-น้ำจิ้มไก่ฉั่วฮะเส็ง 3600 กรัม');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050011', N'11050011', N'ปลาโอแห้งฝอย(40g./แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050015', N'11050015', N'สาหร่ายฝอย(100กรัม/แพ็ค)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050019', N'11050019', N'สาหร่ายวากาเมะแห้ง(500กรัม/20ถุง/ลัง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050031', N'11050031', N'งาขาว(500กรัม/ถุง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050034', N'11050034', N'น้ำมันงา(ตรามังกรคู่)(630ซีซี/ขวด12/ลัง)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050041', N'11050041', N'แป้งชุปทอดคาราอาเกะชิมันโตะ(1กก/ถุง10/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050052', N'11050052', N'ยามาโมริ ทาโกะยากิซอส(1000ML/ขวด6/ลัง)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050057', N'11050057', N'ยามาโมริโชยุ tokkyu(5ลิตร/2กล./แพ็ค)กล.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050065', N'11050065', N'ผงปลา(1กก/10แพ็ค/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050066', N'11050066', N'แป้งข้าวจ้าว(1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050068', N'11050068', N'ข้าวสารญี่ปุ่นซาซานิชิกิ(5กก./ถุง6/กส.)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050081', N'11050081', N'เส้นฮากาตะ#24(100กรัม/ก้อน5/แพ็ค/10กิโล/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050090', N'11050090', N'พริกป่นคาเยนตรามือที่1(500กรัม/แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050092', N'11050092', N'นู้ดเดิ้ลซอส(2.2ลิตร/กล.6/ลัง)กล.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050093', N'11050093', N'น้ำสลัดงาญี่ปุ่นยามาโมริ(1ลิตร/15ขวด/ลัง)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050095', N'11050095', N'น้ำซุปไก่เข้มข้นBTG(1กก/10ถุง/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100016', N'11100016', N'น้ำตาลทราย มิตรผล (25กิโลกระสอบ) (1ถุงกก) กิโล');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050091', N'11050091', N'น้ำจิ้มเกี๊ยวซ่า(ARO1ลิตร)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100064', N'11100064', N'พันซ์JOOZE(500กรัม/24ถุง/ลัง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100066', N'11100066', N'ลิ้นจี่พีชJOOZE(500กรัม/24ถุง/ลัง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100084', N'11100084', N'นมสดคาร์เนชั่น(1กิโล/ถุง20/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100091', N'11100091', N'เป๊ปซี่ กป245มล.(24กป./แพ็ค)กป.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11100092', N'11100092', N'เป๊ปซี่ไม่มีน้ำตาลกป245มล.(24กป./แพ็ค)กป.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11120001', N'11120001', N'ผงชาเขียว 1กก./ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11130034', N'11130034', N'น้ำแร่มองเฟลอร์(500ml./12ขวด/แพ็ค)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800001', N'11800001', N'DETERGENT-Xน้ำยาล้างจานกับเครื่อง20ลิตร/ถัง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800005', N'11800005', N'IN-ไม้จิ้มฟันซองใส 1000ชิ้น/PACK');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800007', N'11800007', N'RINSE-ADD น้ำยาช่วยเร่งแห้ง20ลิตร/ถัง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800020', N'11800020', N'กระดาษคอมแบบใหม่มี Copy ในตัว (10ม้วนแพ็ค) ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800023', N'11800023', N'กระดาษเอนกประสงค์ 24แพ็ค/กล่อง2ม้วน/แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800024', N'11800024', N'กระดาษปอนด์ 75x75 MM.(10ม้วนแพ็ค50มัด)ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800030', N'11800030', N'กระดาษความร้อนแกน12มม.80X80(5ม้วน/แท่ง)ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800041', N'11800041', N'ถุงPEขนาด10x15 นิ้ว(30กก/กส)กก');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800043', N'11800043', N'(ยกเลิก)ถุงขยะดำ 18x20นิ้ว (30ใบ/1มัดมี10แพ็ค)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800044', N'11800044', N'ถุงขยะสีดำ36x45นิ้ว(/1กก/9ใบ/30กก./กส)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800047', N'11800047', N'ถุงพลาสติกร้อน 6x9 (500กรัมแพ็ค) กิโล');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800048', N'11800048', N'ถุงมือพลาสติก (100แพ็คกล่อง) แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800050', N'11800050', N'ถุงหูหิ้วขาว9X18นิ้ว(250g.แพ็ค/30กก./กส.)กก');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800056', N'11800056', N'ถุงขยะดำ18x20นิ้ว(30ใบ/10แพ็ค/มัด)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800065', N'11800065', N'เทปใสแกนใหญ่ 3/4 x36y แกนใหญ่ (96ม้วน/กล่อง)ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800071', N'11800071', N'น้ำยาทำความสะอาดเอนกประสงค์3.8ลิตร/1ถัง)ถัง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800072', N'11800072', N'น้ำยาล้างมือ(1GL./3.8L.)แกล');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800080', N'11800080', N'บริงกี้ (น้ายาล้างจานด้วยมือ)(20ลิตร/ถัง)ถัง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800083', N'11800083', N'ใบบันทึกข้อมูลทางการเงิน / เล่ม');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800102', N'11800102', N'ผ้าหมึก ERC 38 พร้อมตลับ(1ม้วน/กล่อง)กล่อง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800103', N'11800103', N'ฟองน้าอย่างบาง (24ชิ้นกล่อง) ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800105', N'11800105', N'ฟิลม์ใส (4ม้วนกล่อง) ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800121', N'11800121', N'บิลสั่งอาหารตัวใหม่ ปรุ2 2ชุด/ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800140', N'11800140', N'สติกเกอร์ป้ายราคา(10PACK/BOX)(10ม้วน/PACK)ม้วน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800157', N'11800157', N'ผงซักฟอกโปร(1กก./ถุง20ถุง/กล่อง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800158', N'11800158', N'น้ำยาเช็ดกระจกCleaner41(3.8ลิตร/4กล./ลัง)กล.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800161', N'11800161', N'แก๊สกป240g.(24กป/ลัง)กป.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800163', N'11800163', N'ฮอย ฮอย บ้านแมลงสาบ 1กล่อง/3หลัง(กล่อง)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800165', N'11800165', N'ผ้าเช็ดนาโนน้ำเงิน (ผืน)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'01000179', N'1000179', N'FCเพส์ทน้ำซุปดำครบสูตร(1.2กก./ถุง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'05000052', N'5000052', N'FCน้ำจิ้มงาชาบู(1กก./แพ็ค)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'05000051', N'5000051', N'FCน้ำจิ้มพอนสึ(1กก./แพ็ค)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'03000016', N'3000016', N'In-ปังเนยโทสต์ / ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'01000201', N'1000201', N'FC น้ำเชื่อมโทสต์ (1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11020047', N'11020047', N'T-น้ำตาลไอซิ่ง (0.1กก/ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11020059', N'11020059', N'คุกกี้ป่นวนิลาคลาสสิก(10x1กก./ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'05000103', N'5000103', N'FC ชอคลาวา(BM)/(ชิ้น)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'05000102', N'5000102', N'FCเค้กบราวนี่(เล็ก)(ชิ้น)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11010081', N'11010081', N'สันคอหมูม้วนกลมพันฟิล์ม(กก.)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11000441', N'11000441', N'เนื้อออสสันคอ(3kg,up)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11800162', N'11800162', N'IN-แอลกอฮอล์แข็งเฟอร์โน่27กรัม(500/กล่อง)ก้อน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000082', N'2000082', N'FC หมูวากาเมะ (1กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000084', N'2000084', N'FC เศษหมูชาชู(0.5กก./ถุง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000101', N'2000101', N'FC คัสตาร์ดพุดดิ้ง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000102', N'2000102', N'FC พุดดิ้งชาเขียว');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'05000021', N'5000021', N'FCซอสเทอริ(ใช้ซูชิ)(1กก/ถุง)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000070', N'2000070', N'FC เนื้อสันคอสไลซ์ ซูโม่ 3ที่่/แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'02000067', N'2000067', N'FC น้ำซอสข้าวหน้า (600กรัม/ถุง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000593', N'11000593', N'เห็ดทรัฟเฟิลซอส(180g./12ขวด/ลัง)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11010045', N'11010045', N'IN-ไข่ไก่ เบอร์ 4');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050047', N'11050047', N'วาซาบิสด เจแปน(500กรัม/แพ็ค)40แพ็ค/กล่อง)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050051', N'11050051', N'เส้นราเมนสดแช่เย็น(100กรัม/ก้อน8/แพ็ค)ก้อน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050067', N'11050067', N'หอยเชลล์แห้ง(1กก./ถุง)กก / (เบิก0.2/แพ๊ค)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050072', N'11050072', N'เต้าหู้สตรีม(180กรัม)ก้อน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050073', N'11050073', N'หน่อไม้ญี่ปุ่นต้มซีอิ้วแช่เย็น(15กก./ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050074', N'11050074', N'ไขมันหมูเจียว(1กก/ถุง10/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000064', N'11000064', N'เกลือ500g (24ถุงกล่อง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000067', N'11000067', N'คนอร์รสไก่1กก(6กป\กล่อง) กป');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000071', N'11000071', N'น้ำมันปาลม์(กล่อง)(13.75L.)กล่อง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11050101', N'11050101', N'ไก่ไร้กระดูกชิมชิว(1กก./แพ็ค10/ลัง)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000177', N'11000177', N'พริกไทยดำเม็ด (20ถุงกล่อง)(1ถุง500กรัม) (ถุง)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000190', N'11000190', N'มายองเนส (9ถุงกล่อง) ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000293', N'11000293', N'ซอสมะเขือเทศโอชา(900กรัม/12ถุง/ลัง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000311', N'11000311', N'ซอสพริกศรีราชาเผ็ดกลาง900กรัม6ถุงลัง/ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000367', N'11000367', N'(ยกเลิก)ผงชูรส(500กรัม/ถุง)ถุง');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000591', N'11000591', N'น้ำมันน้ำพริกเผา(ฉั่ว)(3ขวด/แพ็ค)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11000600', N'11000600', N'ลูกเกด(ดำ)(1ถุง/200กรัม)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11010011', N'11010011', N'ง่วนเชียงซีอิ๊วหวาน(970ซีซี/ขวด12/ลัง)ขวด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11010016', N'11010016', N'สาหร่ายห่อข้าว(100ชิ้น/แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300046', N'11300046', N'กล่องเจาะช่องGB110(25ใบ/แพ็ค)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300067', N'11300067', N'ถุงพลาสติกร้อน 4.5x8 นิ้ว(500กรัม/แพ็ค)กก.');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300069', N'11300069', N'ถุงซิป 4cmx6cm 1020ใบ(กก)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300070', N'11300070', N'ถุงซิป 7cmX10cm 750ใบ/กก.(กิโล)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300071', N'11300071', N'ถุงซิป 9cm x 13cm 390ใบ/กก (กิโล)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300091', N'11300091', N'ถ้วยน้ำจิ้มฝาในตัว(30กรัม)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300098', N'11300098', N'กล่องกลมดำPLU2477(30/P.16P./ลัง)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300111', N'11300111', N'ชาม+ฝาPLU2430(450มล.25ใบ/แพ็ค)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300131', N'11300131', N'หลอดตรงห่อฟิล์ม6มิลสีดำ(250เส้น/P40/ลัง)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300152', N'11300152', N'ไม้ไผ่หัวน๊อต11ซม(100ชิ้น/แพ็ค)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300153', N'11300153', N'แก้วPETโลโก้ขาววากาเมะ+ฝา(16OZ.)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300154', N'11300154', N'ตะเกียบญี่ปุ่นแบบฉีกมีซอง(100คู่/แพ็ค)คู่');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300155', N'11300155', N'ช้อนซุปพลาสติกสั้น(100ชิ้น/แพ็ค)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300156', N'11300156', N'ชามราเมง2ชั้น(สีดำ250ชุด/ลัง)ชุด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300157', N'11300157', N'กล่องPP3H1 สีดำ3ช่อง+ฝาPET(17.5x22.6x4ซม.)ชุด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300250', N'11300250', N'กระดาษรองแก้ว4ชั้น(plainW80มม.500/ห่อ8/ลัง)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300251', N'11300251', N'แนบกิ้นวากาเมะน้ำตาล(33x33cm1ชั้น8x500ผ/ลัง)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300252', N'11300252', N'กระดาษรอง5x5นิ้ว(500แผ่น/แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300253', N'11300253', N'ถุงกระดาษเคลือบมัน13x21x7.5ซม.(100ใบ/แพ็ค)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300255', N'11300255', N'ถุงไฮโซPEใส(6x14นิ้ว500กรัม88ใบ/แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300256', N'11300256', N'ถุงซีลสูญญากาศ(15x25ซม.100/แพ็ค)ใบ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11300258', N'11300258', N'ถุงไฮโซPEใส(8x16นิ้ว/500กรัม/แพ็ค)แพ็ค');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11500002', N'11500002', N'ชามบะหมี่ดำ2198+ฝา(30ชุด/แพ็ค)ชุด');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800168', N'11800168', N'ฝอยสแตนเลส 3M(1ชิ้น/แพ็ค)ชิ้น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800188', N'11800188', N'ผ้าเช็ดนาโนสีเทา(ผืน)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800200', N'11800200', N'ผ้าเช็ดนาโนสีน้ำตาล(ผืน)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11800214', N'11800214', N'ถุงมือยางแป้ง(PROGLOVES)50คู่/กล่อง)คู่');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090003', N'11090003', N'กระเทียมปอกขาว');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090008', N'11090008', N'แครอท');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090010', N'11090010', N'ต้นหอม (กก.)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090018', N'11090018', N'ผักชีฝรั่ง(พาสลีย์)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090038', N'11090038', N'หอมหัวใหญ่');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090043', N'11090043', N'J-กะหล่ำปลี');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090045', N'11090045', N'J-ต้นหอมญี่ปุ่น');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090070', N'11090070', N'ผักชีฝรั่ง(ใบเลื่อย)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090084', N'11090084', N'เห็ดหูหนูดำ(สด)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'both', N'11090102', N'11090102', N'เลมอน(ลูก)');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11090042', N'11090042', N'J-กวางตุ้งใต้หวัน');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11090047', N'11090047', N'J-ผักกาดขาว');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11090151', N'11090151', N'เห็ดชิเมจิดำ');
INSERT INTO @src (grp, code, item_key, name) VALUES (N'wmt', N'11090152', N'11090152', N'ข้าวโพดฝัก');

/* อุปกรณ์ = ประเภทหรือหมวดสโตร์มีคำว่า "อุปกรณ์" */
DECLARE @equip TABLE (item_key NVARCHAR(50) PRIMARY KEY);
INSERT INTO @equip (item_key)
SELECT item_key FROM dbo.stock_item
 WHERE ISNULL(item_type, N'') LIKE N'%อุปกรณ์%'
    OR ISNULL(store_cat, N'') LIKE N'%อุปกรณ์%';

/* สาขา x วัตถุดิบที่ควรมีหลังแก้ (เฉพาะที่มีในทะเบียน และไม่ใช่อุปกรณ์) */
DECLARE @want TABLE (branch NVARCHAR(10), item_key NVARCHAR(50), PRIMARY KEY (branch, item_key));
INSERT INTO @want (branch, item_key)
SELECT DISTINCT b.branch, s.item_key
  FROM @src s
 CROSS JOIN (SELECT N'wrm' AS branch UNION ALL SELECT N'wmt') b
 WHERE (s.grp = N'both' OR b.branch = s.grp)
   AND EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = s.item_key)
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = s.item_key);

/* สาขา x วัตถุดิบที่มีอยู่ตอนนี้ (ไม่รวมอุปกรณ์) */
DECLARE @cur TABLE (branch NVARCHAR(10), item_key NVARCHAR(50), PRIMARY KEY (branch, item_key));
INSERT INTO @cur (branch, item_key)
SELECT DISTINCT LOWER(b.branch), b.item_key
  FROM dbo.stock_item_branch b
 WHERE LOWER(b.branch) IN (N'wrm', N'wmt')
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = b.item_key);

/* ---- ก. รหัสในไฟล์ที่ไม่พบในทะเบียนวัตถุดิบ ---- */
SELECT N'ก. ไม่พบในทะเบียน' AS [หัวข้อ], s.grp, s.code, s.item_key, s.name
  FROM @src s
 WHERE NOT EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = s.item_key)
 ORDER BY s.grp, s.code;

/* ---- ข. รหัสในไฟล์ที่เป็นหมวดอุปกรณ์ (ข้าม) ---- */
SELECT N'ข. อุปกรณ์ ข้าม' AS [หัวข้อ], s.grp, s.code, i.item_name, i.item_type, i.store_cat
  FROM @src s
  JOIN dbo.stock_item i ON i.item_key = s.item_key
  JOIN @equip e ON e.item_key = s.item_key
 ORDER BY s.code;

/* ---- ค. สรุปต่อสาขา ---- */
SELECT UPPER(br.branch) AS branch,
       (SELECT COUNT(*) FROM dbo.stock_item_branch b WHERE LOWER(b.branch) = br.branch) AS [มีอยู่ตอนนี้],
       (SELECT COUNT(*) FROM @want w WHERE w.branch = br.branch
           AND NOT EXISTS (SELECT 1 FROM @cur c WHERE c.branch = w.branch AND c.item_key = w.item_key)) AS [จะเพิ่ม],
       (SELECT COUNT(*) FROM @cur c WHERE c.branch = br.branch
           AND NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = c.branch AND w.item_key = c.item_key)) AS [จะเอาออก],
       (SELECT COUNT(*) FROM dbo.stock_item_branch b JOIN @equip e ON e.item_key = b.item_key
           WHERE LOWER(b.branch) = br.branch) AS [อุปกรณ์คงไว้],
       (SELECT COUNT(*) FROM @want w WHERE w.branch = br.branch)
     + (SELECT COUNT(*) FROM dbo.stock_item_branch b JOIN @equip e ON e.item_key = b.item_key
           WHERE LOWER(b.branch) = br.branch) AS [หลังแก้]
  FROM (SELECT N'wrm' AS branch UNION ALL SELECT N'wmt') br;

/* ---- ง. รายการที่จะเปลี่ยน ---- */
SELECT x.[การเปลี่ยน], UPPER(x.branch) AS branch, i.item_code, i.item_name, i.item_type, i.store_cat
  FROM (
        SELECT N'เพิ่ม' AS [การเปลี่ยน], w.branch, w.item_key FROM @want w
         WHERE NOT EXISTS (SELECT 1 FROM @cur c WHERE c.branch = w.branch AND c.item_key = w.item_key)
        UNION ALL
        SELECT N'เอาออก', c.branch, c.item_key FROM @cur c
         WHERE NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = c.branch AND w.item_key = c.item_key)
       ) x
  LEFT JOIN dbo.stock_item i ON i.item_key = x.item_key
 ORDER BY x.branch, x.[การเปลี่ยน], i.item_code;

IF @apply = 0
BEGIN
    PRINT N'ดูอย่างเดียว ยังไม่ได้แก้ข้อมูล — ตรวจผลแล้วแก้เป็น SET @apply = 1 แล้วรันใหม่';
    RETURN;
END;

/* ---- แก้จริง ---- */
IF OBJECT_ID(N'dbo.stock_item_branch_bak_wrm_wmt', N'U') IS NULL
    CREATE TABLE dbo.stock_item_branch_bak_wrm_wmt (
        backup_at DATETIME      NOT NULL,
        item_key  NVARCHAR(50)  NOT NULL,
        branch    NVARCHAR(50)  NOT NULL
    );

DECLARE @now DATETIME;
SET @now = GETDATE();
DECLARE @removed INT, @added INT;

BEGIN TRAN;

INSERT INTO dbo.stock_item_branch_bak_wrm_wmt (backup_at, item_key, branch)
SELECT @now, item_key, branch FROM dbo.stock_item_branch WHERE LOWER(branch) IN (N'wrm', N'wmt');

DELETE b
  FROM dbo.stock_item_branch b
 WHERE LOWER(b.branch) IN (N'wrm', N'wmt')
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = b.item_key)
   AND NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = LOWER(b.branch) AND w.item_key = b.item_key);
SET @removed = @@ROWCOUNT;

INSERT INTO dbo.stock_item_branch (item_key, branch)
SELECT w.item_key, w.branch
  FROM @want w
 WHERE NOT EXISTS (SELECT 1 FROM dbo.stock_item_branch b
                    WHERE b.item_key = w.item_key AND LOWER(b.branch) = w.branch);
SET @added = @@ROWCOUNT;

COMMIT;

SELECT N'แก้เรียบร้อย' AS [ผล], @added AS [เพิ่ม], @removed AS [เอาออก], @now AS [สำรองไว้เวลา];
SELECT UPPER(LOWER(branch)) AS branch, COUNT(*) AS [จำนวนหลังแก้]
  FROM dbo.stock_item_branch
 WHERE LOWER(branch) IN (N'wrm', N'wmt')
 GROUP BY LOWER(branch);
GO
