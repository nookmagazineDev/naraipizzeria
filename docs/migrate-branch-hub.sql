/* ============================================================================
   ย้ายทะเบียนสาขามาเป็น "ทะเบียนแม่" (Branch Hub) — แก้ข้อมูลครั้งเดียว
   ฐานข้อมูล InventoryNarai

   ต่างจาก docs/schema-hr-branch.sql ตรงที่ไฟล์นั้นเป็น "โครงสร้าง" (รันซ้ำได้เรื่อย ๆ)
   ส่วนไฟล์นี้เป็น "การแก้ข้อมูล" ที่ตั้งใจให้เกิดครั้งเดียว เช่นการปิดสาขาสามตัว
   ถ้าเอาไปปนไว้ในไฟล์สคีมา วันหลังใครเปิดสาขากลับมาแล้วมีคนรันสคีมาซ้ำ
   สาขานั้นจะถูกปิดอีกรอบเงียบ ๆ โดยไม่มีใครรู้

   จึงมีตาราง dbo.hr_branch_migration คอยจำว่าขั้นไหนรันไปแล้ว — รันไฟล์นี้ซ้ำกี่ครั้ง
   ก็ไม่แตะข้อมูลที่แก้ไปแล้ว (ดูหัวข้อ "รันซ้ำ" ท้ายไฟล์ถ้าอยากบังคับให้รันใหม่จริง ๆ)

   ⚠️ ไฟล์นี้เป็น UTF-8 (มี BOM) — ห้ามบันทึกทับเป็น ANSI ไม่งั้น N'ปิดการใช้งาน'
      จะเขียนลงฐานเป็นตัวอ่านไม่ออก เหตุผลเต็ม ๆ อยู่หัว docs/schema-hr-branch.sql

   ลำดับการรัน
   ---------------------------------------------------------------------------
     1. รัน docs/schema-hr-branch.sql ก่อน (สร้างคอลัมน์/ตารางใหม่ที่ไฟล์นี้ต้องใช้)
     2. รันไฟล์นี้
     3. ฝั่งระบบตารางงาน (narai_hr) ทำต่อที่ Narai-branch/docs/branch-hub-view.sql

   วิธีรัน:
     sqlcmd -f 65001 -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\migrate-branch-hub.sql

   ที่มา: docs/branch-hub.md หัวข้อ "เฟส 0"
============================================================================ */

USE InventoryNarai;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

/* ===================== สมุดจำว่าขั้นไหนรันไปแล้ว ===================== */
IF OBJECT_ID(N'dbo.hr_branch_migration', N'U') IS NULL
CREATE TABLE dbo.hr_branch_migration (
    step   NVARCHAR(100) NOT NULL,
    ran_at DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_branch_mig_ran DEFAULT (SYSDATETIME()),
    note   NVARCHAR(500) NOT NULL CONSTRAINT DF_hr_branch_mig_note DEFAULT (N''),
    CONSTRAINT PK_hr_branch_migration PRIMARY KEY (step)
);
GO

/* ===================== ขั้นที่ 1: เพิ่มสาขาที่มีแต่ฝั่งสโตร์ =====================
   STS (outlet 55) และ ZK3 (outlet 906) มีอยู่ใน narai-storefct/lib/branches.js
   แต่ไม่เคยอยู่ในทะเบียนนี้เลย ทั้งคู่ปิดไปแล้ว

   ปิดแล้วทำไมยังต้องใส่: ข้อมูลเก่า (ใบเบิก ยอดขาย ค่าใช้จ่าย ตารางงาน) ยังอ้างรหัสนี้อยู่
   ไม่มีในทะเบียน = รายงานย้อนหลังแปลรหัสไม่ออก ขึ้นเป็นช่องว่างหรือเลข outlet ดิบ ๆ
   กติกาข้อ 3 หัว docs/schema-hr-branch.sql บอกไว้แล้วว่า "เลิกใช้ให้ปิด อย่าลบ"
   สาขาที่ไม่เคยถูกบันทึกก็เข้ากติกาเดียวกัน — ใส่แล้วปิด ดีกว่าไม่มี               */
IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch_migration WHERE step = N'2026-09-add-sts-zk3')
BEGIN
    MERGE dbo.hr_branch AS t
    USING (VALUES
        (N'STS',  55, 21, N'เพิ่มย้อนหลังจาก narai-storefct/lib/branches.js — ปิดไปแล้ว'),
        (N'ZK3', 906, 22, N'เพิ่มย้อนหลังจาก narai-storefct/lib/branches.js — ปิดไปแล้ว')
    ) AS s (branch_code, outlet_id, sort_order, note)
    ON t.branch_code = s.branch_code
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (branch_code, branch_name, outlet_id, status, note, sort_order)
        VALUES (s.branch_code, N'', s.outlet_id, N'ปิดการใช้งาน', s.note, s.sort_order);

    INSERT dbo.hr_branch_migration (step, note)
    VALUES (N'2026-09-add-sts-zk3', N'เพิ่ม STS(55) และ ZK3(906) เข้าทะเบียนในสถานะปิดการใช้งาน');
    PRINT N'ขั้นที่ 1: เพิ่ม STS / ZK3 เรียบร้อย';
END
ELSE PRINT N'ขั้นที่ 1: ข้าม (รันไปแล้ว)';
GO

/* ===================== ขั้นที่ 2: ปิดสาขาที่เลิกกิจการแล้ว =====================
   HPS · STS · ZK3 ปิดหมดแล้ว (ยืนยันจากเจ้าของระบบ ก.ย. 2026)

   หมายเหตุเรื่อง HPS: เลข outlet ของสาขานี้เคยไม่ตรงกันสองระบบ (ทะเบียนนี้ใช้ 109
   ส่วน narai-storefct ใช้ 902) ยืนยันแล้วว่า **902 ถูก** — ขั้นที่ 4 ข้างล่างแก้ให้     */
IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch_migration WHERE step = N'2026-09-close-hps-sts-zk3')
BEGIN
    DECLARE @closed INT;

    UPDATE dbo.hr_branch
       SET status    = N'ปิดการใช้งาน',
           closed_at = ISNULL(closed_at, CAST(SYSDATETIME() AS DATE))
     WHERE branch_code IN (N'HPS', N'STS', N'ZK3')
       AND status = N'ใช้งาน';
    SET @closed = @@ROWCOUNT;

    UPDATE dbo.hr_branch
       SET note = N'ปิดกิจการแล้ว'
     WHERE branch_code IN (N'HPS', N'STS', N'ZK3')
       AND note = N'';

    INSERT dbo.hr_branch_migration (step, note)
    VALUES (N'2026-09-close-hps-sts-zk3',
            N'ปิด HPS/STS/ZK3 จำนวน ' + CAST(@closed AS NVARCHAR(10)) + N' สาขา');
    PRINT N'ขั้นที่ 2: ปิดสาขาไปแล้ว ' + CAST(@closed AS NVARCHAR(10)) + N' สาขา';
END
ELSE PRINT N'ขั้นที่ 2: ข้าม (รันไปแล้ว)';
GO

/* ===================== ขั้นที่ 3: ย้ายเป้ายอด/เพดานค่าแรงมาจาก narai_hr =====================
   เดิมค่าพวกนี้อยู่ที่ narai_hr.dbo.hr_branch ซึ่งไม่มีหน้าจอให้แก้ ต้องเปิด SSMS เอง
   ย้ายมาที่ InventoryNarai.dbo.hr_branch_target แล้วแก้จากหน้า HR > จัดการสาขา ได้

   ทั้งสองฐานอยู่บนอินสแตนซ์เดียวกัน (NARAI-PIZZARIA\SQLEXPRESS ตามที่
   Narai-branch/office-server/hr-db.js:6 เขียนไว้) จึงอ่านข้ามฐานด้วยชื่อสามท่อนได้เลย

   ขั้นนี้ข้ามได้ถ้ายังไม่พร้อมทำเฟส 3 — ขั้นที่ 1-2 ไม่ได้ขึ้นกับขั้นนี้
   คัดเฉพาะสาขาที่มีรหัสตรงกันในทะเบียนแม่ (FK บังคับอยู่แล้ว) และเฉพาะแถวที่มีค่าจริง
   ไม่ใช่ศูนย์ทั้งแถว — ศูนย์ทั้งแถวคือ "ยังไม่เคยกรอก" ไม่ใช่ "ตั้งเป้าไว้ที่ศูนย์"        */
IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch_migration WHERE step = N'2026-09-import-targets')
BEGIN
    DECLARE @moved INT = 0;
    DECLARE @sql NVARCHAR(MAX);

    IF DB_ID(N'narai_hr') IS NULL
        PRINT N'ขั้นที่ 3: ข้าม — ไม่พบฐาน narai_hr บนอินสแตนซ์นี้ (รันขั้นนี้ที่เครื่องออฟฟิศ)';
    ELSE IF OBJECT_ID(N'narai_hr.dbo.hr_branch', N'U') IS NULL
        PRINT N'ขั้นที่ 3: ข้าม — ไม่พบตาราง narai_hr.dbo.hr_branch (ย้ายเป็น view ไปแล้วหรือยังไม่ได้สร้าง)';
    ELSE
    BEGIN
        -- @@ROWCOUNT หลัง EXEC ไม่ได้การันตีว่าเป็นของ MERGE ข้างใน — รับจำนวนออกมาทาง OUTPUT แทน
        SET @sql = N'
            MERGE dbo.hr_branch_target AS t
            USING (
                SELECT  b.branch_code,
                        MAX(h.daily_target)   AS daily_target,
                        MAX(h.monthly_target) AS monthly_target,
                        MAX(h.max_wage)       AS max_wage
                  FROM  narai_hr.dbo.hr_branch h
                  JOIN  dbo.hr_branch b ON b.branch_code = UPPER(LTRIM(RTRIM(h.branch)))
                 WHERE  h.daily_target > 0 OR h.monthly_target > 0 OR h.max_wage > 0
                 GROUP BY b.branch_code
            ) AS s ON t.branch_code = s.branch_code
            WHEN NOT MATCHED BY TARGET THEN
                INSERT (branch_code, daily_target, monthly_target, max_wage)
                VALUES (s.branch_code, s.daily_target, s.monthly_target, s.max_wage);
            SET @out = @@ROWCOUNT;';
        EXEC sys.sp_executesql @sql, N'@out INT OUTPUT', @out = @moved OUTPUT;

        INSERT dbo.hr_branch_migration (step, note)
        VALUES (N'2026-09-import-targets',
                N'ย้ายเป้า/เพดานค่าแรงจาก narai_hr มา ' + CAST(@moved AS NVARCHAR(10)) + N' สาขา');
        PRINT N'ขั้นที่ 3: ย้ายค่าเป้ามาแล้ว ' + CAST(@moved AS NVARCHAR(10)) + N' สาขา';
    END
END
ELSE PRINT N'ขั้นที่ 3: ข้าม (รันไปแล้ว)';
GO

/* ===================== ขั้นที่ 4: ซ่อมเลข outlet ของ HPS =====================
   HPS เคยถูกบันทึกเป็น outlet 109 ในทะเบียนนี้และในโค้ดของระบบตารางงาน
   ส่วนฝั่งสโตร์ (narai-storefct) ใช้ 902 มาตลอด — ยืนยันกับเจ้าของระบบแล้วว่า **902 ถูก**
   แปลว่าทุกที่ที่ใช้ 109 อ่านยอดผิดร้านมาตลอด (โค้ดฝั่งนั้นแก้ไปแล้วในรอบเดียวกัน)

   แยกเป็นขั้นของตัวเองไม่ไปรวมกับ seed ในไฟล์สคีมา เพราะ seed เป็น MERGE แบบ
   "มีอยู่แล้วไม่แตะ" ซึ่งถูกต้องสำหรับ seed แต่แปลว่ามันแก้แถวที่ลงไปแล้วไม่ได้

   ⚠️ เงื่อนไข outlet_id = 109 สำคัญ — ถ้ามีคนไปแก้เป็นเลขอื่นด้วยมือแล้ว
      ขั้นนี้จะไม่ไปทับของเขา                                                      */
IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch_migration WHERE step = N'2026-09-fix-hps-outlet')
BEGIN
    DECLARE @fixedHps INT;

    UPDATE dbo.hr_branch
       SET outlet_id = 902, updated_at = SYSDATETIME()
     WHERE branch_code = N'HPS'
       AND outlet_id = 109;
    SET @fixedHps = @@ROWCOUNT;

    INSERT dbo.hr_branch_migration (step, note)
    VALUES (N'2026-09-fix-hps-outlet',
            CASE WHEN @fixedHps > 0
                 THEN N'แก้ outlet ของ HPS จาก 109 เป็น 902'
                 ELSE N'ไม่ต้องแก้ — HPS ไม่ได้เป็น 109 อยู่แล้ว' END);
    PRINT N'ขั้นที่ 4: ' + CASE WHEN @fixedHps > 0
        THEN N'แก้ outlet ของ HPS เป็น 902 แล้ว'
        ELSE N'ข้าม — HPS ไม่ได้เป็น 109 อยู่แล้ว' END;
END
ELSE PRINT N'ขั้นที่ 4: ข้าม (รันไปแล้ว)';
GO

/* ============================ ตรวจผลหลังรัน ============================
SELECT branch_code, branch_name, outlet_id, status, closed_at, note
  FROM dbo.hr_branch ORDER BY sort_order, branch_code;

SELECT * FROM dbo.hr_branch_alias;
SELECT * FROM dbo.hr_branch_target ORDER BY branch_code;
SELECT * FROM dbo.hr_branch_migration ORDER BY ran_at;
============================================================================ */

/* ================================ รันซ้ำ ================================
   อยากให้ขั้นไหนรันใหม่จริง ๆ ให้ลบบรรทัดของขั้นนั้นออกจากสมุดจำก่อน เช่น
       DELETE FROM dbo.hr_branch_migration WHERE step = N'2026-09-import-targets';
   แล้วค่อยรันไฟล์นี้อีกรอบ

   ⚠️ อย่าลบบรรทัด 2026-09-close-hps-sts-zk3 เว้นแต่ตั้งใจจะปิดสาขาพวกนั้นซ้ำจริง ๆ
      ถ้ามีสาขาไหนถูกเปิดกลับมาใช้แล้ว การรันขั้นนั้นซ้ำจะปิดมันอีกครั้ง
============================================================================ */

PRINT N'ย้ายทะเบียนสาขาเป็นทะเบียนแม่ (Branch Hub) เรียบร้อย';
GO
