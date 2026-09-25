/* ตั้งวัตถุดิบของสาขา WRM / WMT ตามไฟล์ wakame.xlsx (ไม่แตะหมวดอุปกรณ์)
   - @both = 148 รหัส ใช้ทั้ง WRM และ WMT · @wmt = 16 รหัส "เฉพาะเมืองทอง" ใช้เฉพาะ WMT
   - วัตถุดิบที่ WRM/WMT ใช้อยู่แต่ไม่อยู่ในรายการ -> เอาสาขานั้นออก
   - ประเภทหรือหมวดสโตร์มีคำว่า "อุปกรณ์" -> ไม่เพิ่ม ไม่ลบ คงไว้ตามเดิม
   รันครั้งแรก @apply = 0 ดูผลในแท็บ Results ก่อน ถ้าถูกต้องค่อยแก้เป็น 1 แล้วรันอีกรอบ
   ข้อมูลเดิมสำรองไว้ที่ dbo.stock_item_branch_bak_wrm_wmt */
USE InventoryNarai;
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply BIT;
SET @apply = 0;   -- 0 = ดูอย่างเดียว · 1 = แก้จริง

DECLARE @both NVARCHAR(MAX), @wmt NVARCHAR(MAX);
SET @both = N'
02000022,11000013,11050089,11000603,31000062,31000052,11000347,11000203,11050007,11050013,
11050037,11050102,11050096,11050071,02000036,01000008,02000086,01000177,01000178,02000009,
02000012,02000016,02000017,02000018,02000076,02000049,02000051,02000064,11010047,11050011,
11050015,11050019,11050031,11050034,11050041,11050052,11050057,11050065,11050066,11050068,
11050081,11050090,11050092,11050093,11050095,11100016,11050091,11100064,11100066,11100084,
11100091,11100092,11120001,11130034,11800001,11800005,11800007,11800020,11800023,11800024,
11800030,11800041,11800043,11800044,11800047,11800048,11800050,11800056,11800065,11800071,
11800072,11800080,11800083,11800102,11800103,11800105,11800121,11800140,11800157,11800158,
11800161,11800163,11800165,02000082,02000084,02000101,02000102,05000021,02000070,02000067,
11000593,11010045,11050047,11050051,11050067,11050072,11050073,11050074,11000064,11000067,
11000071,11050101,11000177,11000190,11000293,11000311,11000367,11000591,11000600,11010011,
11010016,11300046,11300067,11300069,11300070,11300071,11300091,11300098,11300111,11300131,
11300152,11300153,11300154,11300155,11300156,11300157,11300250,11300251,11300252,11300253,
11300255,11300256,11300258,11500002,11800168,11800188,11800200,11800214,11090003,11090008,
11090010,11090018,11090038,11090043,11090045,11090070,11090084,11090102';
SET @wmt = N'
01000179,05000052,05000051,03000016,01000201,11020047,11020059,05000103,05000102,11010081,
11000441,11800162,11090042,11090047,11090151,11090152';

/* แตกรายการรหัส -> @src (item_key = ตัดเลข 0 ข้างหน้าออก เหมือนหน้าเว็บ) */
DECLARE @src TABLE (grp NVARCHAR(10), code NVARCHAR(50), item_key NVARCHAR(50));
DECLARE @s NVARCHAR(MAX), @g NVARCHAR(10), @p INT, @c NVARCHAR(50), @round INT;
SET @round = 1;
WHILE @round <= 2
BEGIN
    IF @round = 1 BEGIN SET @s = @both; SET @g = N'both'; END
    ELSE          BEGIN SET @s = @wmt;  SET @g = N'wmt';  END
    SET @s = REPLACE(REPLACE(REPLACE(@s, CHAR(13), N''), CHAR(10), N''), N' ', N'') + N',';
    WHILE LEN(@s) > 0
    BEGIN
        SET @p = CHARINDEX(N',', @s);
        SET @c = LEFT(@s, @p - 1);
        SET @s = SUBSTRING(@s, @p + 1, LEN(@s));
        IF LEN(@c) > 0
            INSERT INTO @src (grp, code, item_key)
            VALUES (@g, @c, SUBSTRING(@c, PATINDEX(N'%[^0]%', @c), 50));
    END;
    SET @round = @round + 1;
END;

DECLARE @equip TABLE (item_key NVARCHAR(50) PRIMARY KEY);
INSERT INTO @equip (item_key)
SELECT item_key FROM dbo.stock_item
 WHERE ISNULL(item_type, N'') LIKE N'%อุปกรณ์%' OR ISNULL(store_cat, N'') LIKE N'%อุปกรณ์%';

DECLARE @want TABLE (branch NVARCHAR(10), item_key NVARCHAR(50), PRIMARY KEY (branch, item_key));
INSERT INTO @want (branch, item_key)
SELECT DISTINCT b.branch, s.item_key
  FROM @src s
 CROSS JOIN (SELECT N'wrm' AS branch UNION ALL SELECT N'wmt') b
 WHERE (s.grp = N'both' OR b.branch = s.grp)
   AND EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = s.item_key)
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = s.item_key);

DECLARE @cur TABLE (branch NVARCHAR(10), item_key NVARCHAR(50), PRIMARY KEY (branch, item_key));
INSERT INTO @cur (branch, item_key)
SELECT DISTINCT LOWER(b.branch), b.item_key
  FROM dbo.stock_item_branch b
 WHERE LOWER(b.branch) IN (N'wrm', N'wmt')
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = b.item_key);

/* ก. รหัสในไฟล์ที่ไม่พบในทะเบียนวัตถุดิบ */
SELECT N'ก. ไม่พบในทะเบียน' AS [หัวข้อ], s.grp, s.code
  FROM @src s
 WHERE NOT EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = s.item_key)
 ORDER BY s.grp, s.code;

/* ข. รหัสในไฟล์ที่เป็นอุปกรณ์ (ข้าม) */
SELECT N'ข. อุปกรณ์ ข้าม' AS [หัวข้อ], s.code, i.item_name, i.item_type, i.store_cat
  FROM @src s
  JOIN dbo.stock_item i ON i.item_key = s.item_key
  JOIN @equip e ON e.item_key = s.item_key;

/* ค. สรุปต่อสาขา */
SELECT UPPER(br.branch) AS branch,
       (SELECT COUNT(*) FROM dbo.stock_item_branch b WHERE LOWER(b.branch) = br.branch) AS [มีอยู่ตอนนี้],
       (SELECT COUNT(*) FROM @want w WHERE w.branch = br.branch
           AND NOT EXISTS (SELECT 1 FROM @cur c WHERE c.branch = w.branch AND c.item_key = w.item_key)) AS [จะเพิ่ม],
       (SELECT COUNT(*) FROM @cur c WHERE c.branch = br.branch
           AND NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = c.branch AND w.item_key = c.item_key)) AS [จะเอาออก],
       (SELECT COUNT(*) FROM dbo.stock_item_branch b JOIN @equip e ON e.item_key = b.item_key
           WHERE LOWER(b.branch) = br.branch) AS [อุปกรณ์คงไว้]
  FROM (SELECT N'wrm' AS branch UNION ALL SELECT N'wmt') br;

/* ง. รายการที่จะเปลี่ยน */
SELECT x.[การเปลี่ยน], UPPER(x.branch) AS branch, i.item_code, i.item_name
  FROM (SELECT N'เพิ่ม' AS [การเปลี่ยน], w.branch, w.item_key FROM @want w
         WHERE NOT EXISTS (SELECT 1 FROM @cur c WHERE c.branch = w.branch AND c.item_key = w.item_key)
        UNION ALL
        SELECT N'เอาออก', c.branch, c.item_key FROM @cur c
         WHERE NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = c.branch AND w.item_key = c.item_key)) x
  LEFT JOIN dbo.stock_item i ON i.item_key = x.item_key
 ORDER BY x.branch, x.[การเปลี่ยน], i.item_code;

IF @apply = 0
BEGIN
    SELECT N'ดูอย่างเดียว ยังไม่ได้แก้ข้อมูล — ถ้าถูกต้องแก้เป็น SET @apply = 1 แล้วรันใหม่' AS [สถานะ];
    RETURN;
END;

IF OBJECT_ID(N'dbo.stock_item_branch_bak_wrm_wmt', N'U') IS NULL
    CREATE TABLE dbo.stock_item_branch_bak_wrm_wmt (
        backup_at DATETIME NOT NULL, item_key NVARCHAR(50) NOT NULL, branch NVARCHAR(50) NOT NULL);

DECLARE @now DATETIME, @removed INT, @added INT;
SET @now = GETDATE();

BEGIN TRAN;
INSERT INTO dbo.stock_item_branch_bak_wrm_wmt (backup_at, item_key, branch)
SELECT @now, item_key, branch FROM dbo.stock_item_branch WHERE LOWER(branch) IN (N'wrm', N'wmt');

DELETE b FROM dbo.stock_item_branch b
 WHERE LOWER(b.branch) IN (N'wrm', N'wmt')
   AND NOT EXISTS (SELECT 1 FROM @equip e WHERE e.item_key = b.item_key)
   AND NOT EXISTS (SELECT 1 FROM @want w WHERE w.branch = LOWER(b.branch) AND w.item_key = b.item_key);
SET @removed = @@ROWCOUNT;

INSERT INTO dbo.stock_item_branch (item_key, branch)
SELECT w.item_key, w.branch FROM @want w
 WHERE NOT EXISTS (SELECT 1 FROM dbo.stock_item_branch b
                    WHERE b.item_key = w.item_key AND LOWER(b.branch) = w.branch);
SET @added = @@ROWCOUNT;
COMMIT;

SELECT N'แก้เรียบร้อย' AS [สถานะ], @added AS [เพิ่ม], @removed AS [เอาออก], @now AS [สำรองไว้เวลา];
GO
