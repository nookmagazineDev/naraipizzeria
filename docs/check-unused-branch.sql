/* ============================================================================
   หาสาขาที่ยังอยู่ในทะเบียนแต่ไม่ได้ใช้จริง (READ-ONLY ไม่แก้อะไร)

   ตัดสินจากยอดขายจริงฝั่ง POS: NaraiPos.dbo.Ctrans ย้อนหลัง 12 เดือน
   ไม่มีรายการขายเลย = ไม่ได้ใช้ เอาออกจากทะเบียนได้

   รันที่ SSMS (เลือกฐาน InventoryNarai) หรือ:
     sqlcmd -S localhost\SQLEXPRESS -E -d InventoryNarai -i docs\check-unused-branch.sql
   ============================================================================ */
USE InventoryNarai;
GO

/* ---- 1) สาขาในทะเบียน + ขายล่าสุดเมื่อไหร่ (เรียงตัวที่ไม่มีการขายขึ้นก่อน) ---- */
SELECT
    b.branch_code,
    b.outlet_id,
    b.status,
    CASE WHEN a.OutletID IS NULL THEN 'NO SALES 12M' ELSE 'active' END AS used,
    a.last_sale,
    a.line_count
FROM dbo.hr_branch b
LEFT JOIN (
    SELECT OutletID, MAX(PostTime) AS last_sale, COUNT(*) AS line_count
    FROM NaraiPos.dbo.Ctrans
    WHERE PostTime >= DATEADD(MONTH, -12, GETDATE())
    GROUP BY OutletID
) a ON a.OutletID = b.outlet_id
ORDER BY CASE WHEN a.OutletID IS NULL THEN 0 ELSE 1 END, a.last_sale;
GO

/* ---- 2) ขากลับ: POS มีขายอยู่ แต่ยังไม่ได้ลงทะเบียน (สาขาที่ตกหล่น) ---- */
SELECT
    a.OutletID,
    a.last_sale,
    a.line_count
FROM (
    SELECT OutletID, MAX(PostTime) AS last_sale, COUNT(*) AS line_count
    FROM NaraiPos.dbo.Ctrans
    WHERE PostTime >= DATEADD(MONTH, -12, GETDATE())
    GROUP BY OutletID
) a
LEFT JOIN dbo.hr_branch b ON b.outlet_id = a.OutletID
WHERE b.outlet_id IS NULL
ORDER BY a.last_sale DESC;
GO

/* ---- 3) อยากดูย้อนหลังไกลกว่านั้น เปลี่ยน -12 เป็น -24 หรือ -36 แล้วรันข้อ 1 ใหม่ ---- */
