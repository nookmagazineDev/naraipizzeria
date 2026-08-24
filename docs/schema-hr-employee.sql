/* ============================================================================
   รวมรายชื่อพนักงานให้เหลือตารางเดียว: narai_hr.dbo.hr_employee
   รันที่เครื่องออฟฟิศ (SSMS ด้วย sa) — ทุกคำสั่งกันซ้ำได้ รันแล้วรันอีกไม่พัง

   ที่มา
   ---------------------------------------------------------------------------
   ก่อนหน้านี้รายชื่อพนักงานนอนอยู่คนละที่กันสองชุดบนเครื่อง SQL ตัวเดียวกัน

     InventoryNarai.dbo.hr_employee   หน้ารายชื่อพนักงานของ naraipizzeria อ่าน/เขียนอยู่
                                      มี start_date, loga, new_code, photo_url, sort_order
     narai_hr.dbo.hr_employee         ตารางงาน/กะ ของ Narai-branch ใช้ (dbo.hr_timesheet อ้าง
                                      hr_code ตารางนี้) มี daily_wage, resign_date

   สองที่นี้ถูกแก้กันคนละรอบ ชื่อ/สาขา/ตำแหน่ง/สถานะจึงเพี้ยนกันไปเรื่อย ๆ โดยไม่มีอะไรเตือน

   ยึด narai_hr เป็นตารางจริงตัวเดียว เพราะประวัติกะผูกกับ hr_code ของฐานนี้อยู่แล้ว
   ย้ายกลับทางอื่นไม่ได้ สคริปต์นี้จึงเติมคอลัมน์ที่ขาดใส่ narai_hr แล้วย้ายข้อมูลจาก
   InventoryNarai มารวม — ส่วน InventoryNarai.dbo.hr_employee เหลือไว้เป็นสำเนาสำรอง
   ไม่มีใครอ่าน/เขียนอีกแล้ว (ไม่ต้องลบ เก็บไว้เทียบย้อนหลังได้)

   กติกาตอนรวมข้อมูล (แถวที่มี hr_code เดียวกันทั้งสองฐาน)
   ---------------------------------------------------------------------------
     · ยึดค่าฝั่ง narai_hr สำหรับ full_name, branch, emp_type, position, status, daily_wage
       เพราะฝั่งนั้นถูกอัปเดตทุกสัปดาห์ผ่านหน้าลงตารางงาน
     · ดึงจาก InventoryNarai เฉพาะคอลัมน์ที่ narai_hr ไม่เคยมี
       (start_date, loga, new_code, photo_url, sort_order) และเฉพาะช่องที่ยังว่างอยู่
     · คนที่มีเฉพาะใน InventoryNarai -> เพิ่มเข้า narai_hr ทั้งแถว
     · ไม่มีการลบใคร

   ฝั่งโค้ดที่ผูกกับไฟล์นี้
   ---------------------------------------------------------------------------
     lib/sheetsSql.mjs -> HR_EMPLOYEE_TABLE ('narai_hr.dbo.hr_employee')
     ทั้ง readEmployees และ saveEmployee ยิงเข้าตารางนี้ตัวเดียว ทั้งฝั่ง Vercel ที่ต่อ SQL ตรง
     และฝั่ง host-server ที่เครื่องออฟฟิศ (/sheets/employee, /sheets/save)
     ตั้ง env HR_EMPLOYEE_TABLE ทับได้ถ้าวันหลังย้ายฐานอีก

   หมายเหตุ
   ---------------------------------------------------------------------------
     · หน้าพนักงานของ naraipizzeria แก้ได้แค่ 9 ช่องใน EMP_COLUMNS — daily_wage กับ
       resign_date ของ narai_hr ไม่ถูกแตะเลย ยังแก้จากหน้าตารางงานเหมือนเดิม
     · ตั้งสถานะเป็น "ลาออก" จากหน้านี้จะไม่ไปลง resign_date ให้ ต้องกรอกที่หน้าตารางงาน
============================================================================ */

USE narai_hr;
GO

/* ---------------------------------------------------------------------------
   1) ตารางปลายทาง — ปกติมีอยู่แล้ว (ตารางงานใช้อยู่) ท่อนนี้ไว้เผื่อติดตั้งเครื่องใหม่
--------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.hr_employee', N'U') IS NULL
CREATE TABLE dbo.hr_employee (
    hr_code     NVARCHAR(50)   NOT NULL,   -- รหัส HR (คีย์ที่ทั้งสองเว็บใช้อ้าง)
    full_name   NVARCHAR(255)  NULL,       -- ชื่อ - สกุล
    branch      NVARCHAR(50)   NULL,       -- สาขา
    emp_type    NVARCHAR(50)   NULL,       -- ประเภท (รายเดือน/รายวัน)
    status      NVARCHAR(50)   NULL,       -- สถานะ (ทำงาน/ลาออก)
    position    NVARCHAR(100)  NULL,       -- ตำแหน่ง
    CONSTRAINT PK_hr_employee PRIMARY KEY (hr_code)
);
GO

/* ---------------------------------------------------------------------------
   2) เติมคอลัมน์ที่ฝั่ง naraipizzeria ต้องใช้ แต่ narai_hr ไม่เคยมี
      วันเริ่มงานเก็บเป็น "ข้อความ" ตามที่ชีทเขียน (มีทั้ง พ.ศ. '31/03/2545' และ
      ค.ศ. '2002-03-31') หน้าเว็บมี parseThaiDate() แปลงเองอยู่แล้ว — ถ้าดันแปลงเป็น DATE
      ตอนย้าย จะเดาพลาดกับปีที่ตกอยู่ในช่วงที่เป็นได้ทั้งสองแบบ แล้วอายุงานเพี้ยนทั้งระบบ
--------------------------------------------------------------------------- */
IF COL_LENGTH(N'dbo.hr_employee', N'start_date') IS NULL
    ALTER TABLE dbo.hr_employee ADD start_date NVARCHAR(30) NULL;      -- วันเริ่มงาน (ข้อความตามชีท)
GO
IF COL_LENGTH(N'dbo.hr_employee', N'loga') IS NULL
    ALTER TABLE dbo.hr_employee ADD loga NVARCHAR(50) NULL;            -- เลขที่ LOGA
GO
IF COL_LENGTH(N'dbo.hr_employee', N'new_code') IS NULL
    ALTER TABLE dbo.hr_employee ADD new_code NVARCHAR(50) NULL;        -- รหัสใหม่
GO
IF COL_LENGTH(N'dbo.hr_employee', N'photo_url') IS NULL
    ALTER TABLE dbo.hr_employee ADD photo_url NVARCHAR(500) NULL;      -- ลิงก์รูป
GO
IF COL_LENGTH(N'dbo.hr_employee', N'sort_order') IS NULL
    ALTER TABLE dbo.hr_employee ADD sort_order INT NOT NULL
        CONSTRAINT DF_hr_employee_sort DEFAULT (0);                    -- ลำดับที่หน้าเว็บใช้เรียง
GO
-- saveEmployee ประทับเวลาลงคอลัมน์นี้ทุกครั้งที่บันทึก ไม่มีคอลัมน์ = บันทึกไม่ผ่านทั้งคำสั่ง
IF COL_LENGTH(N'dbo.hr_employee', N'updated_at') IS NULL
    ALTER TABLE dbo.hr_employee ADD updated_at DATETIME2(0) NOT NULL
        CONSTRAINT DF_hr_employee_updated DEFAULT (SYSDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_employee_branch'
                 AND object_id = OBJECT_ID(N'dbo.hr_employee'))
CREATE INDEX IX_hr_employee_branch ON dbo.hr_employee (branch, status) INCLUDE (full_name, position);
GO

/* ---------------------------------------------------------------------------
   3) ย้ายข้อมูลจาก InventoryNarai มารวม
      ข้ามไปเลยถ้าไม่มีตารางต้นทาง (เครื่องที่ติดตั้งใหม่ ไม่เคยมีสองฐาน)
--------------------------------------------------------------------------- */
IF OBJECT_ID(N'InventoryNarai.dbo.hr_employee', N'U') IS NOT NULL
BEGIN
    -- 3.1 คนที่มีทั้งสองฐาน: เติมเฉพาะช่องที่ narai_hr ยังว่าง ไม่ทับค่าที่มีอยู่แล้ว
    --     (รันซ้ำจึงไม่ย้อนค่าที่เพิ่งแก้จากหน้าเว็บกลับไปเป็นของเก่า)
    UPDATE t
       SET t.start_date = COALESCE(NULLIF(t.start_date, N''), s.start_date),
           t.loga       = COALESCE(NULLIF(t.loga,       N''), s.loga),
           t.new_code   = COALESCE(NULLIF(t.new_code,   N''), s.new_code),
           t.photo_url  = COALESCE(NULLIF(t.photo_url,  N''), s.photo_url),
           t.sort_order = CASE WHEN t.sort_order = 0 THEN s.sort_order ELSE t.sort_order END
      FROM dbo.hr_employee AS t
      JOIN InventoryNarai.dbo.hr_employee AS s ON s.hr_code = t.hr_code;

    -- 3.2 คนที่มีเฉพาะฝั่ง InventoryNarai: เพิ่มเข้ามาทั้งแถว
    INSERT INTO dbo.hr_employee
        (hr_code, full_name, branch, emp_type, status, position,
         start_date, loga, new_code, photo_url, sort_order)
    SELECT s.hr_code, s.full_name, s.branch, s.emp_type, s.status, s.position,
           s.start_date, s.loga, s.new_code, s.photo_url, s.sort_order
      FROM InventoryNarai.dbo.hr_employee AS s
     WHERE NOT EXISTS (SELECT 1 FROM dbo.hr_employee AS t WHERE t.hr_code = s.hr_code);
END
GO

/* ---------------------------------------------------------------------------
   4) ลำดับการแสดงผล — คนที่ไม่เคยอยู่ในชีทยังไม่มีลำดับ (sort_order = 0)
      ปล่อยไว้จะถูกดันขึ้นไปกองบนสุดก่อนคนที่มีลำดับจริง หน้ารายชื่อจะอ่านยาก
      จึงต่อท้ายให้ เรียงตามสาขาแล้วชื่อ — แตะเฉพาะแถวที่ยังไม่มีลำดับจากชีท
--------------------------------------------------------------------------- */
IF OBJECT_ID(N'InventoryNarai.dbo.hr_employee', N'U') IS NOT NULL
BEGIN
    DECLARE @maxOrder INT = (SELECT ISNULL(MAX(sort_order), 0) FROM dbo.hr_employee);

    ;WITH unranked AS (
        SELECT e.hr_code, e.sort_order,
               ROW_NUMBER() OVER (ORDER BY e.branch, e.full_name, e.hr_code) AS rn
          FROM dbo.hr_employee AS e
         WHERE e.sort_order = 0
           AND NOT EXISTS (SELECT 1 FROM InventoryNarai.dbo.hr_employee AS s WHERE s.hr_code = e.hr_code)
    )
    UPDATE unranked SET sort_order = @maxOrder + rn;
END
GO

/* ---------------------------------------------------------------------------
   5) สรุปให้ดูว่ารวมแล้วได้เท่าไหร่ (ตัวเลขชุดเดียวกับที่หน้ารายชื่อจะแสดง)
--------------------------------------------------------------------------- */
SELECT  COUNT(*)                                                          AS [แถวทั้งหมด],
        SUM(CASE WHEN ISNULL(status, N'') <> N'ลาออก' THEN 1 ELSE 0 END)  AS [ยังทำงาน],
        SUM(CASE WHEN ISNULL(photo_url, N'') <> N'' THEN 1 ELSE 0 END)    AS [มีรูป],
        SUM(CASE WHEN ISNULL(loga, N'') <> N'' THEN 1 ELSE 0 END)         AS [มีเลข_LOGA],
        SUM(CASE WHEN sort_order = 0 THEN 1 ELSE 0 END)                   AS [ยังไม่มีลำดับ]
  FROM dbo.hr_employee;
GO

-- รหัสซ้ำ (ต้องได้ 0 แถว — hr_code เป็นคีย์ที่ตารางงานอ้างอยู่)
SELECT hr_code, COUNT(*) AS n
  FROM dbo.hr_employee
 GROUP BY hr_code HAVING COUNT(*) > 1;
GO

/* ============================================================================
   6) ให้สิทธิ์ login ที่เว็บใช้ต่อเข้ามา — ต้องทำ ไม่งั้นหน้าพนักงานอ่านไม่ขึ้น

   ตารางอื่นของ naraipizzeria อยู่ในฐาน InventoryNarai สิทธิ์ที่เคยให้ไว้ตอน
   schema-sheets.sql จึงไม่ครอบมาถึงฐาน narai_hr — ต้องให้เพิ่มที่นี่อีกรอบ
   ไม่ให้จะขึ้นว่า "The server principal ... is not able to access the database"
   (ถ้าเว็บต่อด้วย sa อยู่แล้วก็ข้ามท่อนนี้ได้)

   เปลี่ยน <ชื่อ login> เป็นชื่อจริงที่ตั้งไว้ใน QCRD_DB_USER / ZK_DB_USER บน Vercel
   แล้วเอา comment ออกทั้งบล็อกก่อนรัน

   USE narai_hr;
   IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'<ชื่อ login>')
       CREATE USER [<ชื่อ login>] FOR LOGIN [<ชื่อ login>];
   ALTER ROLE db_datareader ADD MEMBER [<ชื่อ login>];
   ALTER ROLE db_datawriter ADD MEMBER [<ชื่อ login>];
============================================================================ */
