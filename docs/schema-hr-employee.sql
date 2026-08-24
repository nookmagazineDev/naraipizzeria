/* ═══════════════════════════════════════════════════════════════════════════
   รวมรายชื่อพนักงานให้เหลือตารางเดียว: narai_hr.dbo.hr_employee
   รันที่เครื่องออฟฟิศ (SSMS ด้วย sa) ครั้งเดียว — ทุกคำสั่งรันซ้ำได้ ไม่พังถ้ารันแล้ว

   ก่อนหน้านี้รายชื่อพนักงานอยู่คนละที่กันสองชุดบนเครื่อง SQL ตัวเดียวกัน
     InventoryNarai.dbo.hr_employee   หน้ารายชื่อพนักงานของ naraipizzeria อ่าน/เขียนอยู่
                                      มี start_date, loga, new_code, photo_url, sort_order
     narai_hr.dbo.hr_employee         ตารางงาน/กะ ของ Narai-branch ใช้ (hr_timesheet อ้าง hr_code ตารางนี้)
                                      มี daily_wage, resign_date

   ยึด narai_hr เป็นตารางจริงที่เดียว เพราะตารางงานกับประวัติกะผูกกับ hr_code ของฐานนี้อยู่แล้ว
   สคริปต์นี้จึงเติมคอลัมน์ที่ขาดเข้า narai_hr แล้วย้ายข้อมูลจาก InventoryNarai มารวม

   กติกาตอนรวมข้อมูล (แถวที่มี hr_code เดียวกันทั้งสองฐาน):
     ยึดค่าฝั่ง narai_hr สำหรับ full_name, branch, emp_type, position, status, daily_wage
       เพราะฝั่งนั้นถูกอัปเดตทุกสัปดาห์ผ่านหน้าลงตารางงาน
     ก๊อปมาจาก InventoryNarai เฉพาะคอลัมน์ที่ narai_hr ไม่เคยมี
       (start_date, loga, new_code, photo_url, sort_order)
     คนที่มีเฉพาะใน InventoryNarai -> เพิ่มเข้า narai_hr ทั้งแถว
     ไม่มีการลบใคร

   อยากสลับให้ฝั่ง InventoryNarai ชนะแทน: ดูหมายเหตุที่ขั้นตอน 4
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 0) ดูของจริงก่อนแตะอะไร — เอาไว้เทียบกับตัวเลขหลังรันเสร็จ ────────────── */
SELECT 'narai_hr'       AS db, COUNT(*) AS แถวทั้งหมด FROM narai_hr.dbo.hr_employee
UNION ALL
SELECT 'InventoryNarai' AS db, COUNT(*)               FROM InventoryNarai.dbo.hr_employee;
GO

-- รหัสที่ยาวเกิน 30 ตัวอักษรจะย้ายเข้า narai_hr ไม่ได้ (hr_code เป็น PK NVARCHAR(30)
-- และ hr_timesheet อ้างถึง จึงไม่ขยายความกว้าง) ต้องไม่มีแถวไหนโผล่มาตรงนี้
SELECT hr_code, full_name, LEN(hr_code) AS ความยาวรหัส
  FROM InventoryNarai.dbo.hr_employee
 WHERE LEN(hr_code) > 30;
GO

/* ── 1) เติมคอลัมน์ที่ narai_hr ยังไม่มี ─────────────────────────────────── */
USE narai_hr;
GO

IF COL_LENGTH('dbo.hr_employee', 'start_date') IS NULL
    ALTER TABLE dbo.hr_employee ADD start_date NVARCHAR(30) NULL;      -- วันเริ่มงาน (ข้อความตามชีทเดิม)
GO
IF COL_LENGTH('dbo.hr_employee', 'loga') IS NULL
    ALTER TABLE dbo.hr_employee ADD loga NVARCHAR(50) NULL;            -- เลขที่ LOGA
GO
IF COL_LENGTH('dbo.hr_employee', 'new_code') IS NULL
    ALTER TABLE dbo.hr_employee ADD new_code NVARCHAR(50) NULL;        -- รหัสใหม่
GO
IF COL_LENGTH('dbo.hr_employee', 'photo_url') IS NULL
    ALTER TABLE dbo.hr_employee ADD photo_url NVARCHAR(500) NULL;      -- ลิงก์รูป
GO
IF COL_LENGTH('dbo.hr_employee', 'sort_order') IS NULL
    ALTER TABLE dbo.hr_employee ADD sort_order INT NOT NULL
        CONSTRAINT DF_hr_employee_sort DEFAULT (0);                    -- ลำดับที่ใช้เรียงในหน้าเว็บ
GO

/* ── 2) ขยายความกว้างคอลัมน์ให้รับข้อมูลฝั่ง InventoryNarai ได้ ────────────
   ชื่อ/ประเภท/สถานะ ฝั่งโน้นกว้างกว่า ถ้าไม่ขยายก่อน ข้อมูลบางแถวจะย้ายไม่ผ่าน
   (String or binary data would be truncated)
   ALTER COLUMN ทำไม่ได้ถ้าคอลัมน์ติดอยู่ในดัชนี จึงต้องถอดดัชนีออกแล้วสร้างคืน   */
IF EXISTS (SELECT 1 FROM sys.indexes
            WHERE name = N'IX_hr_employee_branch' AND object_id = OBJECT_ID(N'dbo.hr_employee'))
    DROP INDEX IX_hr_employee_branch ON dbo.hr_employee;
GO

ALTER TABLE dbo.hr_employee ALTER COLUMN full_name NVARCHAR(255) NOT NULL;
GO
ALTER TABLE dbo.hr_employee ALTER COLUMN branch    NVARCHAR(50)  NOT NULL;
GO
ALTER TABLE dbo.hr_employee ALTER COLUMN emp_type  NVARCHAR(50)  NULL;
GO
ALTER TABLE dbo.hr_employee ALTER COLUMN status    NVARCHAR(50)  NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = N'IX_hr_employee_branch' AND object_id = OBJECT_ID(N'dbo.hr_employee'))
    CREATE INDEX IX_hr_employee_branch ON dbo.hr_employee (branch, status)
        INCLUDE (full_name, position, emp_type, daily_wage);
GO

/* ── 3) สำรองตารางทั้งสองฝั่งไว้ก่อนย้าย (เผื่อต้องย้อนกลับ) ─────────────── */
IF OBJECT_ID(N'dbo.hr_employee_backup_premerge', N'U') IS NULL
    SELECT * INTO dbo.hr_employee_backup_premerge FROM dbo.hr_employee;
GO
IF OBJECT_ID(N'InventoryNarai.dbo.hr_employee_backup_premerge', N'U') IS NULL
    SELECT * INTO InventoryNarai.dbo.hr_employee_backup_premerge
      FROM InventoryNarai.dbo.hr_employee;
GO

/* ── 4) รวมข้อมูล InventoryNarai -> narai_hr ──────────────────────────────
   อยากให้ฝั่ง InventoryNarai ชนะสำหรับชื่อ/สาขา/ตำแหน่ง ให้ย้ายบรรทัดใน
   WHEN MATCHED ที่คอมเมนต์ไว้ท้ายบล็อกออกมาใช้แทน                            */
MERGE dbo.hr_employee WITH (HOLDLOCK) AS t
USING (
    SELECT hr_code, full_name, branch, emp_type, status, position,
           start_date, loga, new_code, photo_url, sort_order
      FROM InventoryNarai.dbo.hr_employee
     WHERE LEN(hr_code) <= 30 AND NULLIF(LTRIM(RTRIM(hr_code)), N'') IS NOT NULL
) AS s
   ON t.hr_code = s.hr_code

WHEN MATCHED THEN UPDATE SET
    -- เอาเฉพาะคอลัมน์ที่ narai_hr ไม่เคยมี (ของเดิมเป็น NULL อยู่แล้ว) ไม่ทับของที่สดกว่า
    t.start_date = COALESCE(t.start_date, s.start_date),
    t.loga       = COALESCE(t.loga,       s.loga),
    t.new_code   = COALESCE(t.new_code,   s.new_code),
    t.photo_url  = COALESCE(t.photo_url,  s.photo_url),
    t.sort_order = CASE WHEN t.sort_order = 0 THEN s.sort_order ELSE t.sort_order END,
    t.updated_at = SYSDATETIME()
    -- ให้ InventoryNarai ชนะแทน: เพิ่มสี่บรรทัดนี้เข้าไปในชุดข้างบน
    --   , t.full_name = s.full_name, t.branch = s.branch
    --   , t.emp_type  = s.emp_type,  t.position = s.position

WHEN NOT MATCHED BY TARGET THEN INSERT
    (hr_code, full_name, branch, emp_type, position, daily_wage, status,
     start_date, loga, new_code, photo_url, sort_order)
    VALUES (s.hr_code,
            COALESCE(NULLIF(s.full_name, N''), s.hr_code),   -- full_name เป็น NOT NULL
            COALESCE(NULLIF(s.branch, N''), N'-'),           -- branch ก็เช่นกัน
            s.emp_type, s.position, 0,
            COALESCE(NULLIF(s.status, N''), N'ทำงาน'),
            s.start_date, s.loga, s.new_code, s.photo_url, COALESCE(s.sort_order, 0));
GO

/* ── 5) เช็กผล ──────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS แถวหลังรวม,
       SUM(CASE WHEN status = N'ทำงาน' THEN 1 ELSE 0 END) AS ยังทำงาน,
       SUM(CASE WHEN photo_url IS NOT NULL THEN 1 ELSE 0 END) AS มีรูป,
       SUM(CASE WHEN loga IS NOT NULL THEN 1 ELSE 0 END) AS มีเลข_LOGA
  FROM dbo.hr_employee;
GO

-- คนที่อยู่ใน InventoryNarai แต่ยังไม่ขึ้นใน narai_hr (ควรเป็น 0 แถว — ถ้ามีคือรหัสยาวเกิน 30)
SELECT s.hr_code, s.full_name
  FROM InventoryNarai.dbo.hr_employee s
  LEFT JOIN dbo.hr_employee t ON t.hr_code = s.hr_code
 WHERE t.hr_code IS NULL;
GO

/* ── 6) สิทธิ์ของ login ที่เว็บใช้ ────────────────────────────────────────
   หน้าเว็บต่อ SQL ตรงด้วย login เดียวกับที่ QC/RD ใช้ (env QCRD_DB_USER / ZK_DB_USER / HR_DB_USER)
   ถ้ายังไม่เคยให้สิทธิ์ในฐาน narai_hr จะต่อติดแต่ query ไม่ผ่าน
   ขึ้นว่า "is not able to access the database" — แก้ด้วยคำสั่งข้างล่าง (แทน <login> ด้วยชื่อจริง)   */
-- USE narai_hr;
-- IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'<login>')
--     CREATE USER [<login>] FOR LOGIN [<login>];
-- ALTER ROLE db_datareader ADD MEMBER [<login>];
-- ALTER ROLE db_datawriter ADD MEMBER [<login>];
-- GO

/* ── 7) ตารางเก่าฝั่ง InventoryNarai ─────────────────────────────────────
   อย่าเพิ่งลบ — เว้นไว้สัก 1-2 สัปดาห์ให้แน่ใจว่าหน้าเว็บใช้ narai_hr ได้ครบทุกอย่างก่อน
   จะได้ไม่มีใครเผลอเขียนลงตารางเก่า ให้เปลี่ยนชื่อกันไว้ก่อน (ยังอ่านย้อนหลังได้)
   USE InventoryNarai;
   EXEC sp_rename 'dbo.hr_employee', 'hr_employee_moved_to_narai_hr';                         */
