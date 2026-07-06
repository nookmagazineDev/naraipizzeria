import { useState, useEffect, useMemo } from 'react';
import { PackageSearch, Search, Loader2, AlertCircle, Download } from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx';
import { apiCall } from '../lib/stockApi';

export default function StockTotalList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('storageCat');
  
  // Date Picker state (defaults to today)
  const [apiStartDate, setApiStartDate] = useState('');
  const [apiEndDate, setApiEndDate] = useState('');
  
  const [isFetchingApi, setIsFetchingApi] = useState(false);
  const [branches, setBranches] = useState([]);
  const [selectedBranchDetails, setSelectedBranchDetails] = useState(null);
  const [exportBranch, setExportBranch] = useState('all'); // 'all' = ทุกสาขา หรือชื่อสาขาเดียว

  useEffect(() => {
    // Set default dates to today
    const today = new Date();
    const localDateStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    setApiStartDate(localDateStr);
    setApiEndDate(localDateStr);
    
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    setLoading(true);
    try {
      const branchesRes = await apiCall('getBranches');
      if (branchesRes.status === 'success') {
        const validBranches = branchesRes.data.filter(b => String(b.name).toLowerCase() !== 'all');
        setBranches(validBranches);
      }
      
      // Load initial stock totals without end date (latest available)
      const itemsRes = await apiCall('getStockTotal', { endDate: '' });
      if (itemsRes.status === 'success') {
        setItems(itemsRes.data);
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการโหลดข้อมูลเริ่มต้น');
    } finally {
      setLoading(false);
    }
  };

  const fetchData = async () => {
    if (!apiStartDate || !apiEndDate) {
      toast.error('กรุณาระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }

    setIsFetchingApi(true);
    try {
      // 1. Fetch Total Stock from Apps Script (absolute latest count, ignoring UI dates)
      const stockResPromise = apiCall('getStockTotal', { endDate: '' });

      // Determine earliest count date across all items and branches
      let earliestCountDateStr = null;
      stockResPromise.then(res => {
        if (res.status === 'success') {
          res.data.forEach(item => {
            if (item.branchDetails) {
              item.branchDetails.forEach(bd => {
                if (bd.date) {
                  const parts = bd.date.split(' ')[0].split('/'); // [dd, MM, yyyy]
                  if (parts.length === 3) {
                    const ymd = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    if (!earliestCountDateStr || ymd < earliestCountDateStr) {
                      earliestCountDateStr = ymd;
                    }
                  }
                }
              });
            }
          });
        }
      }).catch(() => {});

      const stockRes = await stockResPromise;
      if (stockRes.status !== 'success') {
        toast.error('ไม่สามารถดึงยอดคงเหลือได้');
        setIsFetchingApi(false);
        return;
      }

      let fetchStartDate = earliestCountDateStr;
      if (!fetchStartDate || fetchStartDate > apiStartDate) {
        fetchStartDate = apiStartDate;
      }

      const todayYMD = new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
      let fetchEndDate = apiEndDate;
      if (todayYMD > fetchEndDate) {
        fetchEndDate = todayYMD;
      }

      const validBranches = branches.filter(b => b.outletId);
      
      const usagePromises = validBranches.map(b => 
        fetch(`/api/usage?branch=${encodeURIComponent(b.name)}&outletId=${encodeURIComponent(b.outletId)}&startDate=${encodeURIComponent(fetchStartDate)}&endDate=${encodeURIComponent(fetchEndDate)}`)
        .then(r => r.json()).catch(() => ({ status: 'error' }))
      );
      
      const receivedPromises = validBranches.map(b => 
        fetch(`/api/orderd?branch=${encodeURIComponent(b.name)}&outletId=${encodeURIComponent(b.outletId)}&startDate=${encodeURIComponent(fetchStartDate)}&endDate=${encodeURIComponent(fetchEndDate)}`)
        .then(r => r.json()).catch(() => ({ status: 'error' }))
      );

      const [usageResults, receivedResults] = await Promise.all([
        Promise.all(usagePromises),
        Promise.all(receivedPromises)
      ]);

      let baseItems = stockRes.data;

      // Aggregate Usage
      const branchUsageMap = {};
      usageResults.forEach((res, idx) => {
        const bName = String(validBranches[idx].name).toLowerCase();
        branchUsageMap[bName] = res.status === 'success' && res.data ? res.data : {};
      });

      // Aggregate Received
      const branchReceivedMap = {};
      receivedResults.forEach((res, idx) => {
        const bName = String(validBranches[idx].name).toLowerCase();
        branchReceivedMap[bName] = res.status === 'success' && res.data ? res.data : {};
      });

      // Merge and Calculate
      const mergedItems = baseItems.map(item => {
        const normId = String(item.productId).replace(/^0+/, '').toLowerCase();
        
        let uiTotalUsage = 0;
        let calculatedTotalRemaining = 0;
        let newBranchDetails = [];

        // 1. Calculate UI Total Usage (within apiStartDate and apiEndDate)
        validBranches.forEach(b => {
          const bName = String(b.name).toLowerCase();
          const bUsageDetails = branchUsageMap[bName]?.[normId]?.details || {};
          Object.entries(bUsageDetails).forEach(([dateKey, qty]) => {
            if (dateKey >= apiStartDate && dateKey <= apiEndDate) {
              uiTotalUsage += qty;
            }
          });
        });

        // 2. Calculate System Balance Per Branch
        if (item.branchDetails && item.branchDetails.length > 0) {
          item.branchDetails.forEach(bd => {
            const bName = String(bd.branch).toLowerCase();
            let branchRemaining = parseFloat(bd.remaining);
            if (isNaN(branchRemaining)) branchRemaining = 0;

            let usageSinceCount = 0;
            let receivedSinceCount = 0;

            if (bd.date) {
              const parts = bd.date.split(' ')[0].split('/'); // [dd, MM, yyyy]
              if (parts.length === 3) {
                const countDateKey = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
                
                const bUsageDetails = branchUsageMap[bName]?.[normId]?.details || {};
                const bReceivedDetails = branchReceivedMap[bName]?.[normId]?.details || {};
                
                // Add received and subtract usage strictly *after* the count date
                Object.entries(bUsageDetails).forEach(([dateKey, qty]) => {
                  if (dateKey > countDateKey) usageSinceCount += qty;
                });
                Object.entries(bReceivedDetails).forEach(([dateKey, qty]) => {
                  if (dateKey > countDateKey) receivedSinceCount += qty;
                });
              }
            }

            const branchSystemBalance = Number((branchRemaining + receivedSinceCount - usageSinceCount).toFixed(2));
            calculatedTotalRemaining += branchSystemBalance;

            newBranchDetails.push({
              ...bd,
              calculatedRemaining: branchSystemBalance,
              usageSinceCount,
              receivedSinceCount
            });
          });
        }

        return {
          ...item,
          uiTotalUsage: Number(uiTotalUsage.toFixed(2)),
          calculatedTotalRemaining: item.branchDetails && item.branchDetails.length > 0 ? Number(calculatedTotalRemaining.toFixed(2)) : '',
          newBranchDetails
        };
      });

      setItems(mergedItems);
      toast.success('ดึงข้อมูลยอดรวมสำเร็จ');

    } catch (error) {
      toast.error('เกิดข้อผิดพลาดในการดึงข้อมูล');
    } finally {
      setIsFetchingApi(false);
    }
  };

  // ── Export Excel ──
  // ทุกสาขา: ตารางแนวตั้ง แถว=ไอเทม หัวคอลัมน์=ชื่อสาขา (สาขาละ 2 คอลัมน์: จำนวน + วันที่ลงข้อมูล)
  // เฉพาะสาขา: ตารางแบบรายงานคลัง — วันที่ | เข้าคลัง | รหัสสินค้า | ชื่อสินค้า | Actual QTY
  const exportExcel = () => {
    const rows = sortedAndFilteredItems;
    if (rows.length === 0) { toast.error('ไม่มีรายการให้ export'); return; }
    const todayStr = new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    const wb = XLSX.utils.book_new();

    if (exportBranch === 'all') {
      const bNames = branches.map(b => String(b.name));
      const h1 = ['รหัส', 'ชื่อสินค้า', 'หน่วย'];
      const h2 = ['', '', ''];
      bNames.forEach(bn => { h1.push(bn.toUpperCase(), ''); h2.push('จำนวน', 'วันที่ลงข้อมูล'); });
      const aoa = [h1, h2];
      rows.forEach(it => {
        const bdMap = {};
        (it.branchDetails || []).forEach(bd => { bdMap[String(bd.branch).toLowerCase()] = bd; });
        const r = [it.productId, it.name, it.unit || ''];
        bNames.forEach(bn => {
          const bd = bdMap[bn.toLowerCase()];
          r.push(
            bd !== undefined ? (parseFloat(bd.remaining) || 0) : '',
            bd?.date ? String(bd.date).split(' ')[0] : ''
          );
        });
        aoa.push(r);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // ผสานหัวคอลัมน์ชื่อสาขาให้คร่อม 2 คอลัมน์ย่อย (จำนวน/วันที่)
      ws['!merges'] = bNames.map((_, i) => ({ s: { r: 0, c: 3 + i * 2 }, e: { r: 0, c: 4 + i * 2 } }));
      ws['!cols'] = [{ wch: 12 }, { wch: 45 }, { wch: 8 }, ...bNames.flatMap(() => [{ wch: 9 }, { wch: 12 }])];
      XLSX.utils.book_append_sheet(wb, ws, 'ยอดรวมทุกสาขา');
      XLSX.writeFile(wb, `stock_total_all_${todayStr}.xlsx`);
    } else {
      const aoa = [['วันที่', 'เข้าคลัง', 'รหัสสินค้า', 'ชื่อสินค้า', 'Actual QTY']];
      rows.forEach(it => {
        const bd = (it.branchDetails || []).find(b => String(b.branch).toLowerCase() === exportBranch.toLowerCase());
        if (!bd) return;
        aoa.push([
          bd.date ? String(bd.date).split(' ')[0] : '',
          exportBranch.toUpperCase(),
          it.productId,
          it.name,
          parseFloat(bd.remaining) || 0,
        ]);
      });
      if (aoa.length === 1) { toast.error(`สาขา ${exportBranch.toUpperCase()} ไม่มีข้อมูลยอดนับ`); return; }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 12 }, { wch: 45 }, { wch: 11 }];
      XLSX.utils.book_append_sheet(wb, ws, exportBranch.toUpperCase());
      XLSX.writeFile(wb, `stock_${exportBranch.toUpperCase()}_${todayStr}.xlsx`);
    }
    toast.success('Export สำเร็จ');
  };

  const sortedAndFilteredItems = useMemo(() => {
    let result = items.filter(item => {
      if (!searchTerm) return true;
      const lowerSearch = searchTerm.toLowerCase();
      return (
        String(item.productId || '').toLowerCase().includes(lowerSearch) ||
        String(item.name || '').toLowerCase().includes(lowerSearch) ||
        String(item.storageCat || '').toLowerCase().includes(lowerSearch)
      );
    });

    result.sort((a, b) => {
      if (sortBy === 'storageCat') {
        const catA = String(a.storageCat || '');
        const catB = String(b.storageCat || '');
        return catA.localeCompare(catB, 'th') || String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'productId') {
        return String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'name') {
        return String(a.name || '').localeCompare(String(b.name || 'th'));
      }
      return 0;
    });

    return result;
  }, [items, searchTerm, sortBy]);

  return (
    <div className="max-w-7xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
          <div className="p-2 bg-fuchsia-100 text-fuchsia-600 rounded-xl">
            <PackageSearch className="w-6 h-6" />
          </div>
          ดูยอดรวมทุกสาขา
        </h1>
        <p className="text-gray-500 mt-1 ml-11">ดูยอดคงเหลือรวม ยอดรับ และยอดใช้ ของทุกสาขาแบบเรียลไทม์</p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-4">
        <div className="relative flex-1 flex gap-2">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input type="text"
              className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-fuchsia-500 focus:border-fuchsia-500 sm:text-sm"
              placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          
          <select 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500 text-gray-700"
          >
            <option value="storageCat">เรียงตามหมวดจัดเก็บ</option>
            <option value="productId">เรียงตามรหัสสินค้า</option>
            <option value="name">เรียงตามชื่อสินค้า</option>
          </select>
        </div>
        
        <div className="flex items-center gap-2 bg-gradient-to-r from-fuchsia-50 to-pink-50 border border-fuchsia-100 p-2 rounded-xl">
          <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">วันที่ :</span>
          <input type="date" value={apiStartDate} onChange={(e) => setApiStartDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
          <span className="text-gray-500 text-sm">-</span>
          <input type="date" value={apiEndDate} onChange={(e) => setApiEndDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
          <button
            onClick={fetchData}
            disabled={isFetchingApi || loading || !apiStartDate || !apiEndDate}
            className="px-4 py-1.5 bg-fuchsia-600 text-white text-sm rounded-lg hover:bg-fuchsia-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
            {isFetchingApi ? <Loader2 className="w-4 h-4 animate-spin" /> : 'คำนวณยอดรวม'}
          </button>
        </div>

        {/* Export Excel: ทุกสาขา (pivot สาขาละ จำนวน+วันที่) หรือเฉพาะสาขา (วันที่|เข้าคลัง|รหัส|ชื่อ|Actual QTY) */}
        <div className="flex items-center gap-2 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-100 p-2 rounded-xl">
          <select
            value={exportBranch}
            onChange={(e) => setExportBranch(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 text-gray-700">
            <option value="all">ทุกสาขา</option>
            {branches.map(b => (
              <option key={b.name} value={b.name}>{String(b.name).toUpperCase()}</option>
            ))}
          </select>
          <button
            onClick={exportExcel}
            disabled={loading || sortedAndFilteredItems.length === 0}
            className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
            <Download className="w-4 h-4" /> Export Excel
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-fuchsia-100 overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-fuchsia-600">
            <Loader2 className="w-10 h-10 animate-spin mb-4" />
            <p className="font-medium text-sm">กำลังโหลดข้อมูลรวมทุกสาขา...</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-24">หมวดจัดเก็บ</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดใช้รวม</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-indigo-600 uppercase w-36 bg-indigo-50/60">ยอดคงเหลือรวมล่าสุด</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {sortedAndFilteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-400">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                      ไม่พบรายการสินค้า
                    </td>
                  </tr>
                ) : sortedAndFilteredItems.map((item, index) => {
                  return (
                    <tr key={item.productId || index} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                      <td className="px-4 py-3 text-sm text-gray-800 font-medium">{item.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-fuchsia-600 font-medium">{item.storageCat || '-'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>

                      {/* ยอดใช้รวม (จาก UI Date Picker) */}
                      <td className="px-4 py-3 text-center bg-emerald-50/30">
                        <div className="font-semibold text-emerald-600 text-sm">
                          {item.uiTotalUsage !== undefined && item.uiTotalUsage > 0 ? item.uiTotalUsage : '-'}
                        </div>
                      </td>

                      {/* ยอดคงเหลือรวมล่าสุด = ผลรวมยอดนับล่าสุดของทุกสาขา (จากชีทข้อมูลนับสตอค) */}
                      <td className="px-4 py-3 text-center bg-indigo-50/30">
                        {(() => {
                          const bd = item.branchDetails || [];
                          const hasData = bd.length > 0;
                          const latestTotal = bd.reduce((s, b) => s + (parseFloat(b.remaining) || 0), 0);
                          return (
                            <div
                              className={`font-semibold text-sm ${hasData ? 'text-indigo-700 cursor-pointer hover:underline' : 'text-gray-400'}`}
                              onClick={() => hasData && setSelectedBranchDetails({ name: item.name, details: bd })}
                              title={hasData ? 'คลิกดูยอดนับล่าสุดแต่ละสาขา + วันที่นับ' : ''}
                            >
                              {hasData ? Number(latestTotal.toFixed(2)) : '-'}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Branch Details Modal */}
      {selectedBranchDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedBranchDetails(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-indigo-100 bg-indigo-50/50">
              <h3 className="font-bold text-indigo-800">ยอดคงเหลือรายสาขา</h3>
              <button onClick={() => setSelectedBranchDetails(null)} className="text-indigo-400 hover:text-indigo-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-4 max-h-[65vh] overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedBranchDetails.name}</p>

              {selectedBranchDetails.details.length > 0 ? (() => {
                // ตารางแนวนอน: หัวคอลัมน์ = ชื่อสาขา, แถวข้อมูล = จำนวน + วันที่กรอกข้อมูล
                const entries = [...selectedBranchDetails.details].sort((a, b) => String(a.branch).localeCompare(String(b.branch)));
                const total = Number(entries.reduce((s, b) => s + (parseFloat(b.remaining) || 0), 0).toFixed(2));
                return (
                  <div className="overflow-x-auto border border-indigo-100 rounded-xl">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="bg-indigo-50/70">
                          <th className="px-3 py-2 text-left text-xs font-bold text-indigo-800 uppercase sticky left-0 bg-indigo-50 whitespace-nowrap border-r border-indigo-100"></th>
                          {entries.map((e, i) => (
                            <th key={i} className="px-3 py-2 text-center text-xs font-bold text-indigo-800 uppercase whitespace-nowrap">
                              {e.branch}{e.type && <div className="text-[9px] font-normal text-gray-400 normal-case">({e.type})</div>}
                            </th>
                          ))}
                          <th className="px-3 py-2 text-center text-xs font-bold text-white bg-indigo-500 uppercase whitespace-nowrap">รวม</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        <tr>
                          <td className="px-3 py-2.5 text-xs font-semibold text-gray-500 sticky left-0 bg-white whitespace-nowrap border-r border-indigo-100">จำนวน</td>
                          {entries.map((e, i) => (
                            <td key={i} className={`px-3 py-2.5 text-center font-bold ${parseFloat(e.remaining) < 0 ? 'text-red-500' : 'text-indigo-600'}`}>
                              {e.remaining}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-center font-bold text-indigo-700 bg-indigo-50">{total}</td>
                        </tr>
                        <tr className="bg-gray-50/60">
                          <td className="px-3 py-2 text-xs font-semibold text-gray-500 sticky left-0 bg-gray-50 whitespace-nowrap border-r border-indigo-100">วันที่กรอกข้อมูล</td>
                          {entries.map((e, i) => (
                            <td key={i} className="px-3 py-2 text-center text-[11px] text-gray-500 whitespace-nowrap">
                              {e.date ? String(e.date).split(' ')[0] : '—'}
                            </td>
                          ))}
                          <td className="px-3 py-2 bg-indigo-50/40"></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                );
              })() : (
                <div className="text-center py-8 text-gray-400 text-sm">ไม่มีข้อมูลสาขา</div>
              )}
            </div>
            <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end">
              <button 
                className="px-4 py-2 bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-200 transition-colors"
                onClick={() => setSelectedBranchDetails(null)}
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
