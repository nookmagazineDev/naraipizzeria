/* Map 2 skipped Excel recipes to their existing QC/RD menus (similar names):
     Excel 5371 FC honey glaze  -> 1000049
     Excel 6085 FC moo-yor+chicken -> 2000075
   Replaces the recipe lines of those 2 menus, sets yield + cost. Backup first.
   @apply = 0 -> dry run (shows old vs new, nothing saved). Change to 1 to save. */
USE InventoryNarai;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply BIT = 0;   -- <<<<<< 0 = dry run, 1 = save for real

IF OBJECT_ID('tempdb..#n') IS NOT NULL DROP TABLE #n;
CREATE TABLE #n (menu_code NVARCHAR(50), seq INT, item_code NVARCHAR(50),
                 qty DECIMAL(18,6), converter DECIMAL(18,4));
INSERT INTO #n VALUES
('1000049',1,'11000001',2800,1000),
('1000049',2,'11000122',1400,770),
('1000049',3,'11300260',41,1),
('1000049',4,'11800202',41,800),
('2000075',1,'11000450',5000,1000),
('2000075',2,'11000300',5000,1000),
('2000075',3,'11090003',300,1000),
('2000075',4,'11000277',400,1000),
('2000075',5,'11100016',400,1000),
('2000075',6,'11000116',180,800),
('2000075',7,'11000177',10,500),
('2000075',8,'11000064',60,500),
('2000075',9,'11000428',40,1000),
('2000075',10,'11800049',0.15,1),
('2000075',11,'11800202',11,800);
IF OBJECT_ID('tempdb..#y') IS NOT NULL DROP TABLE #y;
CREATE TABLE #y (menu_code NVARCHAR(50), yield_qty DECIMAL(18,4));
INSERT INTO #y VALUES
('1000049',41),
('2000075',11);

IF (SELECT COUNT(*) FROM #n) <> 15
   OR (SELECT COUNT(*) FROM dbo.qcrd_menu WHERE menu_code IN ('1000049', '2000075')) <> 2
BEGIN RAISERROR('data not complete or menu not found - nothing changed', 16, 1); RETURN; END

PRINT '===== OLD recipe lines now in QC/RD =====';
SELECT menu_code, seq, item_code, item_name, qty, converter FROM dbo.qcrd_bom
WHERE menu_code IN ('1000049', '2000075') ORDER BY menu_code, seq;

BEGIN TRAN;

IF OBJECT_ID('dbo.qcrd_bom_backup_excel_sep2026', 'U') IS NULL
    SELECT CAST(NULL AS DATETIME2(0)) AS backup_at, CAST(bom_id AS BIGINT) AS bom_id, menu_code,
           menu_name, seq, item_code, item_key, item_name, qty, converter, item_price, unit_cost,
           line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct, updated_at
    INTO dbo.qcrd_bom_backup_excel_sep2026 FROM dbo.qcrd_bom WHERE 1 = 0;
IF OBJECT_ID('dbo.qcrd_menu_backup_excel_sep2026', 'U') IS NULL
    SELECT CAST(NULL AS DATETIME2(0)) AS backup_at, * INTO dbo.qcrd_menu_backup_excel_sep2026
    FROM dbo.qcrd_menu WHERE 1 = 0;
DECLARE @now DATETIME2(0) = SYSDATETIME();
INSERT INTO dbo.qcrd_bom_backup_excel_sep2026
SELECT @now, bom_id, menu_code, menu_name, seq, item_code, item_key, item_name, qty, converter,
       item_price, unit_cost, line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct,
       updated_at
FROM dbo.qcrd_bom WHERE menu_code IN ('1000049', '2000075');
INSERT INTO dbo.qcrd_menu_backup_excel_sep2026
SELECT @now, * FROM dbo.qcrd_menu WHERE menu_code IN ('1000049', '2000075');

IF OBJECT_ID('tempdb..#keep') IS NOT NULL DROP TABLE #keep;
SELECT menu_code, LOWER(item_key) AS item_key, MAX(tag) AS tag, MAX(CAST(no_deduct AS INT)) AS no_deduct
INTO #keep FROM dbo.qcrd_bom WHERE menu_code IN ('1000049', '2000075')
GROUP BY menu_code, LOWER(item_key);

DELETE FROM dbo.qcrd_bom WHERE menu_code IN ('1000049', '2000075');
INSERT INTO dbo.qcrd_bom
    (menu_code, menu_name, seq, item_code, item_key, item_name, qty, converter, item_price,
     unit_cost, line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct)
SELECT n.menu_code, qm.menu_name, n.seq, n.item_code, k.item_key,
       COALESCE(si.item_name, n.item_code), n.qty, CASE WHEN n.converter = 0 THEN 1000 ELSE n.converter END,
       NULLIF(si.price, 0),
       CASE WHEN si.price > 0 THEN si.price / CASE WHEN n.converter = 0 THEN 1000 ELSE n.converter END END,
       CASE WHEN si.price > 0 THEN n.qty * si.price / CASE WHEN n.converter = 0 THEN 1000 ELSE n.converter END END,
       NULL, NULL, NULL, NULL, kp.tag, ISNULL(kp.no_deduct, 0)
FROM #n n
CROSS APPLY (SELECT LOWER(ISNULL(NULLIF(SUBSTRING(n.item_code,
             PATINDEX('%[^0]%', n.item_code + '.'), 50), ''), '0')) AS item_key) k
JOIN dbo.qcrd_menu qm ON qm.menu_code = n.menu_code
OUTER APPLY (SELECT TOP 1 s.item_name, s.price FROM dbo.stock_item s
             WHERE LOWER(s.item_key) = k.item_key) si
LEFT JOIN #keep kp ON kp.menu_code = n.menu_code AND kp.item_key = k.item_key;

UPDATE qm SET yield_qty = y.yield_qty,
       cost = (SELECT ROUND(SUM(ISNULL(b.line_cost, 0)), 4) FROM dbo.qcrd_bom b
               WHERE b.menu_code = qm.menu_code),
       updated_at = SYSDATETIME()
FROM dbo.qcrd_menu qm JOIN #y y ON y.menu_code = qm.menu_code;

PRINT '===== NEW recipe lines (from Excel) =====';
SELECT b.menu_code, b.seq, b.item_code, b.item_name, b.qty, b.converter, b.line_cost
FROM dbo.qcrd_bom b WHERE b.menu_code IN ('1000049', '2000075') ORDER BY b.menu_code, b.seq;
SELECT menu_code, menu_name, yield_qty, cost FROM dbo.qcrd_menu
WHERE menu_code IN ('1000049', '2000075');

IF @apply = 1
BEGIN COMMIT; PRINT '*** SAVED (COMMIT) - 15 lines'; END
ELSE
BEGIN ROLLBACK; PRINT '*** DRY RUN ONLY - nothing saved (ROLLBACK). Set @apply = 1 to save.'; END
