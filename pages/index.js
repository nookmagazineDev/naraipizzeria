import Head from 'next/head';
import { useState, useEffect, useMemo, useRef } from 'react';
import { 
  LayoutDashboard, 
  TrendingUp, 
  DollarSign, 
  Users, 
  Receipt, 
  Menu, 
  X, 
  Download, 
  Search, 
  ChevronLeft, 
  ChevronRight, 
  ChevronDown,
  Folder,
  ShoppingBag,
  CreditCard,
  Building2,
  Calendar,
  Layers,
  ArrowRightLeft,
  Eye,
  CheckCircle,
  XCircle,
  HelpCircle,
  Filter,
  PackageSearch
} from 'lucide-react';
import StockList from '../components/StockList';
import StockTotalList from '../components/StockTotalList';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  LineChart, 
  Line, 
  PieChart, 
  Pie, 
  Cell, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend 
} from 'recharts';
import * as XLSX from 'xlsx';

/* ───────── OUTLETS ───────── */
const OUTLETS = {
  7:'SJP', 12:'CRM', 19:'XCM', 37:'SLR', 51:'SUM',
  59:'XUM', 61:'SCS', 63:'SMP', 67:'XSB', 72:'XHH',
  78:'HRS', 79:'CLK', 80:'P90', 109:'HPS', 400:'ZBW',
  401:'ZPT', 500:'NPT', 501:'WRM', 503:'WMT', 904:'IPR', 906:'ZK3',
};

const OUTLET_LIST = Object.entries(OUTLETS).map(([id, name]) => ({
  id: parseInt(id),
  name
})).sort((a, b) => a.id - b.id);

/* ───────── EXCLUSIONS (ไม่นำมาคำนวณ) ───────── */
const EXCLUDE_TABLES = [600];                       // โต๊ะที่ตัดออก (500 กลับไปนับต้นทุนจริงแล้ว)
const EXCLUDE_ITEMS = [206001];                    // itemCode เดี่ยวที่ตัดออก
const EXCLUDE_ITEM_RANGES = [[500002, 500026]];    // ช่วง itemCode ที่ตัดออก
const COVER_ITEMS = [101001, 101002, 101003, 101004, 101107, 101108]; // ไอเทมบุฟเฟ่ใช้นับ "จำนวนคน"
// วัตถุดิบ (กก) โต๊ะเตรียม — แยกออกจากต้นทุนที่ใช้คิดกำไร/ขาดทุน
const PREP_KG_ITEMS = [206041, 206038, 205003, 205002, 205007, 205006, 205021, 206035, 206040, 205014, 205004, 206034];
function isPrepKgItem(code) { return PREP_KG_ITEMS.indexOf(parseInt(code)) >= 0; }

// ช่องทางการจ่ายในตารางรายวัน → predicate หาบิลที่เข้าช่องนั้น (กดดูรายการบิลได้)
const _pt = r => String(r.paidType || r.PaidType || '').toUpperCase();
const PAYMENT_CELLS = {
  cash:      { label: 'Cash',      fn: r => parseFloat(r.cash || r._Cash || r._cash || 0) > 0 },
  credit:    { label: 'Credit',    fn: r => parseFloat(r.credit || r._Credit || r._credit || 0) > 0 },
  qrCredit:  { label: 'QRcredit',  fn: r => parseFloat(r.qrCredit || r._QRcredit || r._qrCredit || r._qrcredit || 0) > 0 },
  qr:        { label: 'QR',        fn: r => parseFloat(r.qr || r._QR || r._qr || 0) > 0 },
  oc:        { label: 'OC',        fn: r => parseFloat(r.oc || r._OC || r._oc || 0) > 0 },
  grab:      { label: 'GRAB',      fn: r => _pt(r).includes('GRAB') || parseFloat(r.grab || 0) > 0 },
  robinhood: { label: 'ROBINHOOD', fn: r => _pt(r).includes('ROBINHOOD') || parseFloat(r.robinhood || 0) > 0 },
  shopee:    { label: 'SHOPEE',    fn: r => _pt(r).includes('SHOPEE') || parseFloat(r.shopee || 0) > 0 },
  lineMan:   { label: 'LINE MAN',  fn: r => _pt(r).includes('LINE MAN') || _pt(r).includes('LINEMAN') || parseFloat(r.lineMan || 0) > 0 },
  voucher:   { label: 'Voucher',   fn: r => parseFloat(r.voucher || r._Voucher || r._voucher || 0) > 0 || _pt(r).includes('VOUCHER') },
  alipay:    { label: 'Alipay',    fn: r => parseFloat(r.alipay || r._Alipay || r._alipay || 0) > 0 || _pt(r).includes('ALIPAY') },
  wechat:    { label: 'WeChat',    fn: r => parseFloat(r.weChat || r.wechat || r._WeChat || r._wechat || 0) > 0 || _pt(r).includes('WECHAT') },
  copay:     { label: 'คนละครึ่ง 2', fn: r => _pt(r).includes('SPAYLATE2') || _pt(r).includes('คนละครึ่ง') || _pt(r).includes('HALF') || parseFloat(r.copay || 0) > 0 },
  catering:  { label: 'จัดเลี้ยง', fn: r => _pt(r).includes('CATERING') || _pt(r).includes('จัดเลี้ยง') || parseFloat(r.catering || 0) > 0 },
  totalSales:{ label: 'Total Sales', fn: () => true },
};

function isExcludedTable(tid) {
  return EXCLUDE_TABLES.indexOf(parseInt(tid)) >= 0;
}
function isExcludedItem(code) {
  const ic = parseInt(code);
  if (EXCLUDE_ITEMS.indexOf(ic) >= 0) return true;
  return EXCLUDE_ITEM_RANGES.some(r => ic >= r[0] && ic <= r[1]);
}

/* ───────── HELPERS ───────── */
const fmtMoney = v => {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : '฿' + n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtNum = v => {
  if (v === null || v === undefined || v === '') return '-';
  const n = parseFloat(v);
  return isNaN(n) ? String(v) : n.toLocaleString('th-TH');
};

const outletLabel = id => {
  const name = OUTLETS[parseInt(id)];
  return name ? `${id} · ${name}` : (id != null ? String(id) : '-');
};

// ยึด "วันที่เปิดบิล" (startTime) เป็นหลักทุกเมนู; fallback เป็นวันปิด/ชำระ (date) ถ้าไม่มี
const dateFromRow = row => {
  const t = row['startTime'];
  if (t) return String(t).slice(0, 10);
  const d = row['Date'] || row['date'];
  return d ? String(d).slice(0, 10) : '-';
};

// ดึงข้อมูลเผื่อท้ายช่วงไว้กี่วัน (รองรับบิลที่ "เปิด" ในช่วง แต่ "ปิด/ชำระ" ข้ามวัน)
const OPEN_DATE_BUFFER_DAYS = 2;
const addDaysStr = (str, days) => {
  const d = new Date(str);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const normalizeArray = json =>
  Array.isArray(json) ? json
  : Array.isArray(json.data) ? json.data
  : Array.isArray(json.result) ? json.result
  : Object.values(json).find(v => Array.isArray(v)) ?? [];

const PAGE_SIZE = 50;

function ExcelFilterDropdown({
  columnKey,
  label,
  value = [],
  onChange,
  dataset,
  getValFn
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef(null);

  // Get all unique values from dataset
  const allUniqueOptions = useMemo(() => {
    if (!isOpen) return [];
    if (!dataset || !dataset.length) return [];
    const set = new Set();
    dataset.forEach(row => {
      const v = getValFn ? getValFn(row, columnKey) : String(row[columnKey] ?? '');
      set.add(v || '-');
    });
    return Array.from(set).sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b), 'th');
    });
  }, [dataset, columnKey, getValFn, isOpen]);

  // Click outside listener to close dropdown
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Search filter options
  const filteredOptions = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return allUniqueOptions;
    return allUniqueOptions.filter(opt => String(opt).toLowerCase().includes(q));
  }, [allUniqueOptions, searchQuery]);

  // Toggle selection
  const handleToggleOption = (opt) => {
    let next;
    if (value.includes(opt)) {
      next = value.filter(v => v !== opt);
    } else {
      next = [...value, opt];
    }
    onChange(next);
  };

  // Select all matching search
  const handleSelectAll = () => {
    const allSelected = filteredOptions.every(opt => value.includes(opt));
    if (allSelected) {
      onChange(value.filter(opt => !filteredOptions.includes(opt)));
    } else {
      onChange(Array.from(new Set([...value, ...filteredOptions])));
    }
  };

  const handleClear = () => {
    onChange([]);
    setSearchQuery('');
  };

  const isFiltered = value && value.length > 0;

  return (
    <div className="relative inline-block w-full text-left" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-1 px-1.5 py-0.5 border rounded text-[9px] font-medium transition-all bg-white select-none ${
          isFiltered 
            ? 'border-amber-500 text-amber-700 bg-amber-50/50 ring-1 ring-amber-500 font-bold' 
            : 'border-slate-200 text-slate-500 hover:border-slate-300'
        }`}
      >
        <span className="truncate max-w-[80px]">
          {isFiltered 
            ? `${value.length} รายการ`
            : 'ทั้งหมด'
          }
        </span>
        {isFiltered ? (
          <Filter size={8} className="text-amber-600 flex-shrink-0 fill-current" />
        ) : (
          <ChevronDown size={8} className="text-slate-400 flex-shrink-0" />
        )}
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1 w-56 rounded-lg bg-white shadow-xl ring-1 ring-black/5 focus:outline-none z-50 text-slate-700 border border-slate-100 flex flex-col max-h-[300px]">
          {/* Search box */}
          <div className="p-2 border-b border-slate-100 flex-shrink-0 bg-slate-50 rounded-t-lg">
            <input
              type="text"
              placeholder="ค้นหาค่าตัวกรอง..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
            />
          </div>

          {/* Quick controls */}
          <div className="px-2 py-1.5 border-b border-slate-100 flex justify-between text-[10px] text-slate-500 flex-shrink-0 select-none bg-white">
            <button
              type="button"
              onClick={handleSelectAll}
              className="hover:text-amber-600 font-semibold"
            >
              {filteredOptions.every(opt => value.includes(opt)) ? 'ล้างการเลือก' : 'เลือกทั้งหมด'}
            </button>
            {isFiltered && (
              <button
                type="button"
                onClick={handleClear}
                className="text-rose-500 hover:text-rose-700 font-semibold"
              >
                ล้างฟิลเตอร์
              </button>
            )}
          </div>

          {/* List of options */}
          <div className="overflow-y-auto flex-1 py-1 max-h-[180px]">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-center text-xs text-slate-400">ไม่พบตัวเลือก</div>
            ) : (
              filteredOptions.map(opt => {
                const checked = value.includes(opt);
                return (
                  <label
                    key={opt}
                    className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-slate-50 cursor-pointer select-none text-slate-700 font-normal"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleOption(opt)}
                      className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span className="truncate">{opt}</span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── COLUMN DEFINITIONS & FILTER VALUE HELPERS ───────── */
const SALES_COLUMNS = [
  { key: 'Date', label: 'วันที่', type: 'date' },
  { key: 'checkID', label: 'Check ID', type: 'text' },
  { key: 'outletID', label: 'สาขา', type: 'outlet' },
  { key: 'tableID', label: 'โต๊ะ', type: 'num' },
  { key: 'cashierName', label: 'แคชเชียร์', type: 'text' },
  { key: 'waiterName', label: 'พนักงานรับออเดอร์', type: 'text' },
  { key: 'amount', label: 'Amount', type: 'amount' },
  { key: 'beforeVat', label: 'ยอดขายก่อน Vat', type: 'money' },
  { key: 'vat', label: 'Vat', type: 'money' },
  { key: 'billTotal', label: 'Bill Total', type: 'bill' },
  { key: 'billCost', label: 'ต้นทุนรวม', type: 'money' },
  { key: 'paidType', label: 'ประเภทชำระ', type: 'badge' },
  { key: 'memberTel', label: 'เลขที่สมาชิก', type: 'text' },
  { key: 'cover', label: 'Cover', type: 'num' },
  { key: 'coverAd', label: 'Cover Ad', type: 'num' },
  { key: 'coverAll', label: 'Cover All', type: 'num' },
  { key: 'startTime', label: 'เวลาเริ่ม', type: 'datetime' },
  { key: 'date', label: 'เวลาปิดบิล', type: 'datetime' },
  { key: 'checkDesc', label: 'รายละเอียด', type: 'text' },
  { key: 'orderID', label: 'Order ID', type: 'text' },
];

const DETAIL_COLUMNS = [
  { key: '_date', label: 'วันที่', type: 'date' },
  { key: 'chkCheckID', label: 'เลขที่บิล', type: 'text' },
  { key: 'outletID', label: 'สาขา', type: 'outlet' },
  { key: 'itemCode', label: 'รหัสสินค้า', type: 'text' },
  { key: 'nameThai', label: 'ชื่อรายการ', type: 'text' },
  { key: 'quantity', label: 'จำนวน', type: 'num' },
  { key: 'unitPrice', label: 'ราคา/หน่วย', type: 'money' },
  { key: 'grossPrice', label: 'มูลค่ารวม', type: 'money' },
  { key: 'unitCost', label: 'ต้นทุน/หน่วย', type: 'money' },
  { key: 'lineCost', label: 'ต้นทุนรวม', type: 'money' },
  { key: 'tax', label: 'ภาษี', type: 'money' },
  { key: 'tableID', label: 'เลขที่โต๊ะ', type: 'num' },
  { key: 'prtOrdTime', label: 'เวลาสั่ง', type: 'datetime' },
  { key: 'void', label: 'การยกเลิก', type: 'void' },
  { key: 'voidTime', label: 'เวลายกเลิก', type: 'datetime' },
  { key: 'orderID', label: 'เลขที่ออเดอร์', type: 'text' },
];

const DAILY_COLUMNS = [
  { key: 'date', label: 'วันที่', type: 'date' },
  { key: 'outletID', label: 'รหัสสาขา', type: 'outlet' },
  { key: 'name', label: 'ชื่อสาขา', type: 'text' },
  { key: 'dineIn', label: 'Dine-in', type: 'money' },
  { key: 'takeHome', label: 'Take-Home', type: 'money' },
  { key: 'delivery', label: 'Delivery', type: 'money' },
  { key: 'serviceChg', label: 'Service10%', type: 'money' },
  { key: 'netSales', label: 'Net Sales', type: 'money' },
  { key: 'vat', label: 'Vat', type: 'money' },
  { key: 'grossSales', label: 'Gross Sales', type: 'money' },
  { key: 'cash', label: 'Cash', type: 'money' },
  { key: 'credit', label: 'Credit', type: 'money' },
  { key: 'qrCredit', label: 'QRcredit', type: 'money' },
  { key: 'qr', label: 'QR', type: 'money' },
  { key: 'oc', label: 'OC', type: 'money' },
  { key: 'grab', label: 'GRAB', type: 'money' },
  { key: 'robinhood', label: 'ROBINHOOD', type: 'money' },
  { key: 'shopee', label: 'SHOPEE', type: 'money' },
  { key: 'lineMan', label: 'LINE MAN', type: 'money' },
  { key: 'voucher', label: 'Voucher', type: 'money' },
  { key: 'alipay', label: 'Alipay', type: 'money' },
  { key: 'wechat', label: 'WeChat', type: 'money' },
  { key: 'copay', label: 'คนละครึ่ง 2', type: 'money' },
  { key: 'catering', label: 'จัดเลี้ยง', type: 'money' },
  { key: 'totalSales', label: 'Total Sales', type: 'money_bold' },
  { key: 'billCount', label: 'ผลรวมบิล', type: 'number' },
  { key: 'totalCovers', label: 'จำนวนหัว', type: 'number' },
  { key: 'takeHomeBills', label: 'บิล Take-Home', type: 'number' },
  { key: 'takeHomeCost', label: 'ต้นทุน Take-Home', type: 'money' },
  { key: 'deliveryBills', label: 'บิล Delivery', type: 'number' },
  { key: 'deliveryCost', label: 'ต้นทุน Delivery', type: 'money' },
  { key: 'buffet259Qty', label: 'จำนวน Buffet 259', type: 'number' },
  { key: 'buffet259Amt', label: 'ยอดขาย Buffet 259', type: 'money' },
  { key: 'buffet359Qty', label: 'จำนวน Premium 359', type: 'number' },
  { key: 'buffet359Amt', label: 'ยอดขาย Premium 359', type: 'money' },
  { key: 'kid159Qty', label: 'จำนวน Kid Premium 159', type: 'number' },
  { key: 'kid159Amt', label: 'ยอดขาย Kid Premium 159', type: 'money' },
  { key: 'kid109Qty', label: 'จำนวน Kid Buffet 109', type: 'number' },
  { key: 'kid109Amt', label: 'ยอดขาย Kid Buffet 109', type: 'money' },
  { key: 'kidFreeQty', label: 'จำนวนเด็กฟรี (101005)', type: 'number' },
  { key: 'totalCost', label: 'ต้นทุนรวม', type: 'money' },
  { key: 'prepCost', label: 'ต้นทุนโต๊ะเตรียม(กก)', type: 'money' },
  { key: 'costPct', label: '% ต้นทุน/ยอดขาย', type: 'percent' }
];

const ITEM_COLUMNS = [
  { key: 'itemCode', label: 'รหัสไอเทม', type: 'text' },
  { key: 'nameThai', label: 'ชื่อรายการ (ไทย)', type: 'text' },
  { key: 'nameEng', label: 'ชื่อ (Eng)', type: 'text' },
  { key: 'totalQty', label: 'จำนวนรวม', type: 'num' },
  { key: 'totalGross', label: 'มูลค่ารวม (฿)', type: 'money' },
  { key: 'totalCost', label: 'ต้นทุนรวม (฿)', type: 'money' },
  { key: 'profit', label: 'กำไร (฿)', type: 'money' }
];

function getColFilterValue(row, key) {
  if (key === '_date') {
    const t = row.prtOrdTime || row.postTime || row.startTime;
    return t ? String(t).slice(0, 10) : '';
  }
  if (key === 'Date') return dateFromRow(row);
  if (key === 'startTime' || key === 'date' || key === 'prtOrdTime' || key === 'voidTime') {
    const v = row[key];
    return v ? String(v).slice(0, 19) : '';
  }
  if (key === 'outletID') return outletLabel(row[key]);
  if (key === 'void') return row[key] ? 'ยกเลิก' : 'ปกติ';

  // Formatting money and numbers for exact match/display
  const isSalesCol = SALES_COLUMNS.find(c => c.key === key);
  const isDetailCol = DETAIL_COLUMNS.find(c => c.key === key);
  const col = isSalesCol || isDetailCol;
  if (col) {
    if (col.type === 'money' || col.type === 'money_bold' || col.type === 'amount' || col.type === 'bill') return fmtMoney(row[key]);
    if (col.type === 'number' || col.type === 'num') return fmtNum(row[key]);
  }
  return String(row[key] ?? '');
}

const getDailyColFilterValue = (row, key) => {
  if (key === 'outletID') return outletLabel(row.outletID);
  if (key === 'date') return String(row.date ?? '').slice(0, 10);
  const col = DAILY_COLUMNS.find(c => c.key === key);
  if (col) {
    if (col.type === 'money' || col.type === 'money_bold') return fmtMoney(row[key]);
    if (col.type === 'number') return fmtNum(row[key]);
    if (col.type === 'percent') return `${parseFloat(row[key] || 0).toFixed(2)}%`;
  }
  return String(row[key] ?? '');
};

const getItemColFilterValue = (row, key) => {
  if (key === 'totalQty') return fmtNum(row[key]);
  if (key === 'totalGross' || key === 'totalCost' || key === 'profit') return fmtMoney(row[key]);
  return String(row[key] ?? '');
};

export default function App() {
  const [isMounted, setIsMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard', 'sales', 'dailySale', 'details', 'itemSearch'
  const [accOpen, setAccOpen] = useState(true);
  const [stockOpen, setStockOpen] = useState(true);
  const [branchChartMode, setBranchChartMode] = useState('sales'); // 'sales' or 'covers'

  // Date filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedOutlet, setSelectedOutlet] = useState('');

  // Datasets
  const [salesRaw, setSalesRaw] = useState([]);
  const [detailRaw, setDetailRaw] = useState([]);        // กรองแล้ว (ใช้คำนวณ)
  const [detailAllRaw, setDetailAllRaw] = useState([]);  // ครบทุกแถว (ใช้แสดงหน้ารายละเอียด)
  const [costMap, setCostMap] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadProgress, setLoadProgress] = useState(null); // { current, total, text }

  // Tab 2 - Sales filter & states
  const [salesSearch, setSalesSearch] = useState('');
  const [salesSort, setSalesSort] = useState({ col: null, asc: true });
  const [salesPage, setSalesPage] = useState(1);
  const [salesColF, setSalesColF] = useState({});

  // Tab 3 - Details filter & states
  const [detailSearch, setDetailSearch] = useState('');
  const [detailSort, setDetailSort] = useState({ col: null, asc: true });
  const [detailPage, setDetailPage] = useState(1);
  const [detailColF, setDetailColF] = useState({});

  // Tab 4 - Daily Sales filter & states
  const [dailySearch, setDailySearch] = useState('');
  const [dailySort, setDailySort] = useState({ col: 'date', asc: false });
  const [dailyPage, setDailyPage] = useState(1);
  const [dailyColF, setDailyColF] = useState({});

  // Modal
  const [modal, setModal] = useState({ open: false, checkID: null, rows: [], loading: false, error: '' });
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [prepModalOpen, setPrepModalOpen] = useState(false);
  const [dailyCostModal, setDailyCostModal] = useState({ open: false, type: 'cost', date: null, outletID: null });
  const [excludedRaw, setExcludedRaw] = useState([]);
  const [excludedModalOpen, setExcludedModalOpen] = useState(false);

  // Comparison State
  const [compareOutlets, setCompareOutlets] = useState([]); // Array of outlet IDs

  // Item Search Tab State
  const [itemSearch, setItemSearch] = useState('');
  const [itemSearchSort, setItemSearchSort] = useState({ col: 'totalQty', asc: false });
  const [selectedItem, setSelectedItem] = useState(null); // { itemCode, nameThai, nameEng }
  const [itemColF, setItemColF] = useState({});
  const [showDailyBillsModal, setShowDailyBillsModal] = useState({ open: false, title: '', bills: [] });

  useEffect(() => {
    setIsMounted(true);
    const now = new Date();
    const som = new Date(now.getFullYear(), now.getMonth(), 1);
    setStartDate(som.toISOString().slice(0, 10));
    setEndDate(now.toISOString().slice(0, 10));
  }, []);

  // Helper to chunk date range
  function getChunks(startStr, endStr, chunkSizeDays = 5) {
    const chunks = [];
    let start = new Date(startStr);
    const end = new Date(endStr);
    
    while (start <= end) {
      let chunkEnd = new Date(start);
      chunkEnd.setDate(chunkEnd.getDate() + chunkSizeDays - 1);
      if (chunkEnd > end) {
        chunkEnd = new Date(end);
      }
      
      chunks.push({
        start: start.toISOString().slice(0, 10),
        end: chunkEnd.toISOString().slice(0, 10)
      });
      
      start = new Date(chunkEnd);
      start.setDate(start.getDate() + 1);
    }
    return chunks;
  }

  // Fetch both APIs sequentially in chunks
  async function loadData() {
    if (!startDate || !endDate) {
      setError('กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด');
      return;
    }
    if (startDate > endDate) {
      setError('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด');
      return;
    }

    setLoading(true);
    setError('');
    
    // Reset view states
    setSalesSearch('');
    setSalesSort({ col: null, asc: true });
    setSalesPage(1);
    setSalesColF({});

    setDetailSearch('');
    setDetailSort({ col: null, asc: true });
    setDetailPage(1);
    setDetailColF({});

    setDailySearch('');
    setDailySort({ col: 'date', asc: false });
    setDailyPage(1);
    setDailyColF({});

    setItemSearch('');
    setItemSearchSort({ col: 'totalQty', asc: false });
    setSelectedItem(null);
    setItemColF({});

    try {
      // ดึงเผื่อท้ายช่วง +buffer วัน เพื่อให้ได้บิลที่เปิดในช่วงแต่ปิด/ชำระข้ามวันมาด้วย
      const fetchEndDate = addDaysStr(endDate, OPEN_DATE_BUFFER_DAYS);
      const chunks = getChunks(startDate, fetchEndDate, 5); // 5-day chunks
      let allSales = [];
      let allDetails = [];
      
      // Start fetching costs in parallel
      const costPromise = fetch(`/api/cost`).then(async r => {
        if (!r.ok) {
          const errJson = await r.json().catch(() => ({}));
          throw new Error(errJson.error || `Cost API: HTTP ${r.status}`);
        }
        return r.json();
      });

      // ออเดอร์เพิ่มเติมจาก Google Sheet (สาขา XUM โต๊ะ 800) — ดึงขนานกันไป
      const extraPromise = fetch(`/api/extra-orders`)
        .then(r => r.ok ? r.json() : { sales: [], details: [] })
        .catch(() => ({ sales: [], details: [] }));

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setLoadProgress({
          current: i,
          total: chunks.length,
          text: `กำลังดึงข้อมูลช่วง ${chunk.start} ถึง ${chunk.end} (ชุดที่ ${i + 1}/${chunks.length})`
        });

        const [salesRes, detailRes] = await Promise.all([
          fetch(`/api/sales?start=${chunk.start}&end=${chunk.end}`),
          fetch(`/api/detail?start=${chunk.start}&end=${chunk.end}`)
        ]);

        const salesJson = await salesRes.json();
        const detailJson = await detailRes.json();

        if (!salesRes.ok) throw new Error(salesJson.error || `Sales API: HTTP ${salesRes.status} (ช่วง ${chunk.start} ถึง ${chunk.end})`);
        if (!detailRes.ok) throw new Error(detailJson.error || `Detail API: HTTP ${detailRes.status} (ช่วง ${chunk.start} ถึง ${chunk.end})`);

        allSales = allSales.concat(normalizeArray(salesJson));
        allDetails = allDetails.concat(normalizeArray(detailJson));
      }

      // รวมออเดอร์เพิ่มเติมจาก Google Sheet (XUM โต๊ะ 800) ก่อนกรองช่วงวัน
      const extra = await extraPromise;
      allSales = allSales.concat(extra.sales || []);
      allDetails = allDetails.concat(extra.details || []);

      // คัดเฉพาะแถวที่ "วันเปิดบิล" (startTime) อยู่ในช่วงที่เลือกจริง ๆ
      // (ตัดบิลส่วนเกินที่ดึงเผื่อมาจาก buffer ท้ายช่วงออก)
      const inOpenRange = r => {
        const d = dateFromRow(r);
        return d >= startDate && d <= endDate;
      };
      allSales = allSales.filter(inOpenRange);
      allDetails = allDetails.filter(inOpenRange);

      setLoadProgress({
        current: chunks.length,
        total: chunks.length,
        text: 'กำลังโหลดข้อมูลราคาต้นทุน...'
      });

      const costJson = await costPromise;

      // กรองโต๊ะ/ไอเทมที่ไม่นำมาคำนวณ (เช่น โต๊ะ 500/600, ไอเทมเตรียมของ)
      const cleanSales = allSales.filter(r => !isExcludedTable(r.tableID ?? r.TableID));
      const cleanDetails = allDetails.filter(r =>
        !isExcludedTable(r.tableID ?? r.TableID) && !isExcludedItem(r.itemCode));
      // เก็บแถวที่ถูกตัดออก (โต๊ะ 600 + ไอเทม 206001/500002-500026) ไว้แสดงในการ์ด "ไม่นับ"
      const excludedDetails = allDetails.filter(r =>
        isExcludedTable(r.tableID ?? r.TableID) || isExcludedItem(r.itemCode));

      setSalesRaw(cleanSales);
      setDetailRaw(cleanDetails);
      setDetailAllRaw(allDetails);
      setExcludedRaw(excludedDetails);
      setCostMap(costJson);
      setLoaded(true);

      // Prepopulate branch comparison with top 3 outlets by sales
      const outletTotals = {};
      allSales.forEach(r => {
        const outlet = r.outletID;
        outletTotals[outlet] = (outletTotals[outlet] || 0) + (parseFloat(r.billTotal) || 0);
      });
      const topOutlets = Object.entries(outletTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => parseInt(id));
      setCompareOutlets(topOutlets);

    } catch (err) {
      console.error(err);
      setError('ไม่สามารถดึงข้อมูลได้: ' + err.message);
    } finally {
      setLoading(false);
      setLoadProgress(null);
    }
  }



  function applyFilters(arr, cols, searchVal, colFilters, selectedBranch) {
    let d = [...arr];
    
    // Global filter by Branch selection in top bar
    if (selectedBranch) {
      d = d.filter(r => String(r.outletID) === String(selectedBranch));
    }

    // Global Search
    if (searchVal) {
      const q = searchVal.toLowerCase();
      d = d.filter(r => 
        cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)) ||
        String(r.nameEng ?? '').toLowerCase().includes(q)
      );
    }

    // Column Filters (Excel-like multiselect)
    const activeF = Object.entries(colFilters).filter(([, vals]) => vals && vals.length > 0);
    if (activeF.length) {
      d = d.filter(row =>
        activeF.every(([key, selectedVals]) => {
          const val = getColFilterValue(row, key) || '-';
          return selectedVals.includes(val);
        })
      );
    }

    return d;
  }

  function sortArray(arr, col, asc) {
    if (!col) return arr;
    return [...arr].sort((a, b) => {
      let va = a[col], vb = b[col];
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) { va = na; vb = nb; }
      else { va = String(va ?? ''); vb = String(vb ?? ''); }
      return va < vb ? (asc ? -1 : 1) : va > vb ? (asc ? 1 : -1) : 0;
    });
  }
  // Map checkID to its total cost
  const salesCostMap = useMemo(() => {
    const map = {};
    if (!detailRaw.length || !costMap) return map;
    detailRaw.forEach(r => {
      if (r.void || !r.chkCheckID) return;
      const cid = String(r.chkCheckID);
      const qty = parseFloat(r.quantity || 0);
      const unitCost = parseFloat(costMap[r.itemCode] || 0);
      map[cid] = (map[cid] || 0) + (qty * unitCost);
    });
    return map;
  }, [detailRaw, costMap]);

  // Map checkID -> waiterName (พนักงานรับออเดอร์ จากข้อมูลรายละเอียด)
  const checkWaiterMap = useMemo(() => {
    const map = {};
    detailRaw.forEach(r => {
      if (!r.chkCheckID) return;
      const cid = String(r.chkCheckID);
      if (!map[cid] && r.waiterName) map[cid] = r.waiterName;
    });
    return map;
  }, [detailRaw]);

  // Sales data with computed billCost attached
  const salesWithCost = useMemo(() => {
    return salesRaw.map(row => {
      const cid = String(row.checkID);
      const amt = parseFloat(row.amount || row.Amount || 0);
      const vatVal = parseFloat(row.vat || row.Vat || 0);
      return {
        ...row,
        billCost: salesCostMap[cid] ?? 0,
        vat: vatVal,
        beforeVat: amt - vatVal,
        waiterName: checkWaiterMap[cid] || ''
      };
    });
  }, [salesRaw, salesCostMap, checkWaiterMap]);

  // Processed Data
  const filteredSales = useMemo(() => {
    const d = applyFilters(salesWithCost, SALES_COLUMNS, salesSearch, salesColF, selectedOutlet);
    return sortArray(d, salesSort.col, salesSort.asc);
  }, [salesWithCost, salesSearch, salesColF, selectedOutlet, salesSort]);

  // Enrich detail rows with unit cost & line cost (ต้นทุน/หน่วย, ต้นทุนรวม)
  const detailsWithCost = useMemo(() => detailAllRaw.map(r => {
    const unitCost = costMap[r.itemCode] ?? 0;
    return { ...r, unitCost, lineCost: unitCost * (parseFloat(r.quantity) || 0) };
  }), [detailAllRaw, costMap]);

  const filteredDetails = useMemo(() => {
    const d = applyFilters(detailsWithCost, DETAIL_COLUMNS, detailSearch, detailColF, selectedOutlet);
    return sortArray(d, detailSort.col, detailSort.asc);
  }, [detailsWithCost, detailSearch, detailColF, selectedOutlet, detailSort]);

  const dailyCostSplitMap = useMemo(() => {
    const map = {};
    if (!detailRaw.length || !costMap || !salesRaw.length) return map;

    // Map checkID -> tableID
    const checkTableIDMap = {};
    salesRaw.forEach(row => {
      checkTableIDMap[String(row.checkID)] = parseInt(row.tableID || row.TableID || 0);
    });

    detailRaw.forEach(r => {
      if (r.void === 'V' || r.Void === 'V' || r.void) return;
      const d = dateFromRow(r);
      const oid = r.outletID;
      const key = `${d}_${oid}`;
      if (!map[key]) {
        map[key] = { dineInCost: 0, takeHomeCost: 0, deliveryCost: 0, prepCost: 0 };
      }
      const qty = parseFloat(r.quantity || r.Qty || 0);
      const code = String(r.itemCode || '');
      const costVal = parseFloat(costMap[code] || 0);
      const cost = qty * costVal;

      if (isPrepKgItem(code)) { map[key].prepCost += cost; return; }   // ต้นทุนโต๊ะเตรียม(กก) แยก

      const tid = checkTableIDMap[String(r.chkCheckID)] || 0;
      if (tid === 300) {
        map[key].takeHomeCost += cost;
      } else if (tid === 400 || tid === 401) {
        map[key].deliveryCost += cost;
      } else {
        map[key].dineInCost += cost;
      }
    });
    return map;
  }, [detailRaw, costMap, salesRaw]);

  const dailyBuffetItemsMap = useMemo(() => {
    const map = {};
    if (!detailRaw.length) return map;

    detailRaw.forEach(r => {
      if (r.void === 'V' || r.Void === 'V' || r.void) return;
      const d = dateFromRow(r);
      const oid = r.outletID;
      const key = `${d}_${oid}`;
      if (!map[key]) {
        map[key] = {
          buffet259Qty: 0,
          buffet259Amt: 0,
          buffet359Qty: 0,
          buffet359Amt: 0,
          kid159Qty: 0,
          kid159Amt: 0,
          kid109Qty: 0,
          kid109Amt: 0,
          kidFreeQty: 0
        };
      }

      const qty = parseFloat(r.quantity || r.Qty || 0);
      const grossPrice = parseFloat(r.grossPrice || r.amount || 0);
      const code = String(r.itemCode || '').trim();

      if (code === '101107' || code === '101001') {
        map[key].buffet259Qty += qty;
        map[key].buffet259Amt += grossPrice;
      } else if (code === '101002') {
        map[key].buffet359Qty += qty;
        map[key].buffet359Amt += grossPrice;
      } else if (code === '101004' || code === '101104') {
        map[key].kid159Qty += qty;
        map[key].kid159Amt += grossPrice;
      } else if (code === '101108') {
        map[key].kid109Qty += qty;
        map[key].kid109Amt += grossPrice;
      } else if (code === '101005') {
        map[key].kidFreeQty += qty;
      }
    });
    return map;
  }, [detailRaw]);

  const dailyReportData = useMemo(() => {
    if (!salesRaw.length) return [];
    
    const groups = {};
    salesRaw.forEach(row => {
      const d = dateFromRow(row);
      const oid = row.outletID;
      const key = `${d}_${oid}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(row);
    });

    return Object.entries(groups).map(([key, bills]) => {
      const [date, outletStr] = key.split('_');
      const outletID = parseInt(outletStr);
      const name = OUTLETS[outletID] || 'Unknown';

      // 1. Order type Net Sales (amount - vat)
      let dineIn = 0;
      let takeHome = 0;
      let delivery = 0;
      let dineInBills = 0;
      let takeHomeBills = 0;
      let deliveryBills = 0;

      bills.forEach(r => {
        // ใช้ billTotal (ยอดจริงต่อบิล) เพื่อให้ตรงกับหน้ารายงานยอดขาย
        const billTotal = parseFloat(r.billTotal || r.BillTotal || r.amount || r.Amount || 0);
        const vat = parseFloat(r.vat || r.Vat || 0);
        const net = billTotal - vat;
        
        const tid = parseInt(r.tableID || r.TableID || 0);
        if (tid === 300) {
          takeHome += net;
          takeHomeBills++;
        } else if (tid === 400 || tid === 401) {
          delivery += net;
          deliveryBills++;
        } else {
          dineIn += net;
          dineInBills++;
        }
      });

      // 2. Service Charge (if any)
      const serviceChg = bills.reduce((sum, r) => sum + parseFloat(r.service || r.Service || r.serviceChg || r.ServiceChg || r.service10 || r.Service10 || 0), 0);

      // 3. Net, Vat, Gross Sales
      const netSales = dineIn + takeHome + delivery;
      const vat = bills.reduce((sum, r) => sum + parseFloat(r.vat || r.Vat || 0), 0);
      const grossSales = netSales + vat;

      // 4. Payments
      const cash = bills.reduce((sum, r) => sum + parseFloat(r.cash || r._Cash || r._cash || 0), 0);
      const credit = bills.reduce((sum, r) => sum + parseFloat(r.credit || r._Credit || r._credit || 0), 0);
      const qrCredit = bills.reduce((sum, r) => sum + parseFloat(r.qrCredit || r._QRcredit || r._qrCredit || r._qrcredit || 0), 0);
      const qr = bills.reduce((sum, r) => sum + parseFloat(r.qr || r._QR || r._qr || 0), 0);
      const oc = bills.reduce((sum, r) => sum + parseFloat(r.oc || r._OC || r._oc || 0), 0);
      
      const grab = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('GRAB')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.grab || 0);
      }, 0);
      
      const robinhood = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('ROBINHOOD')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.robinhood || 0);
      }, 0);
      
      const shopee = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('SHOPEE')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.shopee || 0);
      }, 0);
      
      const lineMan = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('LINE MAN') || pt.includes('LINEMAN')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.lineMan || 0);
      }, 0);

      const voucher = bills.reduce((sum, r) => {
        const fromCol = parseFloat(r.voucher || r._Voucher || r._voucher || 0);
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        const fromPt = pt.includes('VOUCHER') ? parseFloat(r.billTotal || r.BillTotal || r.amount || 0) : 0;
        return sum + Math.max(fromCol, fromPt);
      }, 0);

      const alipay = bills.reduce((sum, r) => {
        const fromCol = parseFloat(r.alipay || r._Alipay || r._alipay || 0);
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        const fromPt = pt.includes('ALIPAY') ? parseFloat(r.billTotal || r.BillTotal || r.amount || 0) : 0;
        return sum + Math.max(fromCol, fromPt);
      }, 0);

      const wechat = bills.reduce((sum, r) => {
        const fromCol = parseFloat(r.weChat || r.wechat || r._WeChat || r._wechat || 0);
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        const fromPt = pt.includes('WECHAT') ? parseFloat(r.billTotal || r.BillTotal || r.amount || 0) : 0;
        return sum + Math.max(fromCol, fromPt);
      }, 0);

      const copay = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('SPAYLATE2') || pt.includes('คนละครึ่ง') || pt.includes('HALF')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.copay || 0);
      }, 0);

      const catering = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('CATERING') || pt.includes('จัดเลี้ยง')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.catering || 0);
      }, 0);

      const gojek = bills.reduce((sum, r) => {
        const pt = String(r.paidType || r.PaidType || '').toUpperCase();
        if (pt.includes('GOJEK')) return sum + parseFloat(r.billTotal || r.BillTotal || r.amount || 0);
        return sum + parseFloat(r.gojek || 0);
      }, 0);

      // Total Sales = sum of all payment methods
      const totalSales = cash + credit + qrCredit + qr + oc + grab + robinhood + shopee + lineMan + voucher + alipay + wechat + copay + catering + gojek;

      const billCount = bills.length;

      const costData = dailyCostSplitMap[key] || { dineInCost: 0, takeHomeCost: 0, deliveryCost: 0, prepCost: 0 };
      const dineInCost = costData.dineInCost;
      const takeHomeCost = costData.takeHomeCost;
      const deliveryCost = costData.deliveryCost;
      const prepCost = costData.prepCost;
      const totalCost = dineInCost + takeHomeCost + deliveryCost;   // ไม่รวม prep

      const buffetData = dailyBuffetItemsMap[key] || {
        buffet259Qty: 0,
        buffet259Amt: 0,
        buffet359Qty: 0,
        buffet359Amt: 0,
        kid159Qty: 0,
        kid159Amt: 0,
        kid109Qty: 0,
        kid109Amt: 0,
        kidFreeQty: 0
      };

      // จำนวนหัว = จำนวนหัวที่ "จ่ายเงิน" = ผลรวมจานบุฟเฟต์ที่ขายจริง (ไม่รวมเด็กฟรี 101005)
      const totalCovers = buffetData.buffet259Qty + buffetData.buffet359Qty + buffetData.kid159Qty + buffetData.kid109Qty;

      const costPct = netSales > 0 ? (totalCost / netSales) * 100 : 0;

      return {
        date,
        outletID,
        name,
        dineIn,
        takeHome,
        takeHomeBills,
        takeHomeCost,
        delivery,
        deliveryBills,
        deliveryCost,
        serviceChg,
        netSales,
        vat,
        grossSales,
        cash,
        credit,
        qrCredit,
        qr,
        oc,
        grab,
        robinhood,
        shopee,
        lineMan,
        voucher,
        alipay,
        wechat,
        copay,
        catering,
        gojek,
        totalSales,
        billCount,
        totalCovers,
        totalCost,
        prepCost,
        dineInBills,
        dineInCost,
        buffet259Qty: buffetData.buffet259Qty,
        buffet259Amt: buffetData.buffet259Amt,
        buffet359Qty: buffetData.buffet359Qty,
        buffet359Amt: buffetData.buffet359Amt,
        kid159Qty: buffetData.kid159Qty,
        kid159Amt: buffetData.kid159Amt,
        kid109Qty: buffetData.kid109Qty,
        kid109Amt: buffetData.kid109Amt,
        kidFreeQty: buffetData.kidFreeQty,
        costPct
      };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.outletID - b.outletID);
  }, [salesRaw, dailyCostSplitMap, dailyBuffetItemsMap]);

  const filteredDailyReport = useMemo(() => {
    let d = [...dailyReportData];
    
    // Global filter by Branch selection in top bar
    if (selectedOutlet) {
      d = d.filter(r => String(r.outletID) === String(selectedOutlet));
    }

    // Global Search (search by date or branch name/ID)
    if (dailySearch) {
      const q = dailySearch.toLowerCase();
      d = d.filter(r => 
        String(r.date).toLowerCase().includes(q) ||
        String(r.outletID).toLowerCase().includes(q) ||
        String(r.name).toLowerCase().includes(q)
      );
    }

    // Column Filters (Excel-like multiselect)
    const activeF = Object.entries(dailyColF).filter(([, vals]) => vals && vals.length > 0);
    if (activeF.length) {
      d = d.filter(row =>
        activeF.every(([key, selectedVals]) => {
          const val = getDailyColFilterValue(row, key) || '-';
          return selectedVals.includes(val);
        })
      );
    }

    // Sorting
    if (dailySort.col) {
      const col = dailySort.col;
      const asc = dailySort.asc;
      d.sort((a, b) => {
        let va = a[col], vb = b[col];
        const na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) { va = na; vb = nb; }
        else { va = String(va ?? ''); vb = String(vb ?? ''); }
        return va < vb ? (asc ? -1 : 1) : va > vb ? (asc ? 1 : -1) : 0;
      });
    }

    return d;
  }, [dailyReportData, dailySearch, dailyColF, selectedOutlet, dailySort]);

  // Tab 1 (Dashboard) Calculations
  const stats = useMemo(() => {
    const sales = selectedOutlet 
      ? salesRaw.filter(r => String(r.outletID) === String(selectedOutlet)) 
      : salesRaw;

    const details = selectedOutlet
      ? detailRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : detailRaw;

    const count = sales.length;
    const sumAmount = sales.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const sumBill = sales.reduce((s, r) => s + (parseFloat(r.billTotal) || 0), 0);
    const sumVat = sales.reduce((s, r) => s + (parseFloat(r.vat || r.Vat || 0) || 0), 0);
    const sumBeforeVat = sumBill - sumVat;
    // จำนวนคน = ผลรวมจำนวนไอเทมบุฟเฟ่ 101001-101004 (ไม่นับรายการ void)
    const sumCover = details.reduce((s, r) => {
      if (r.void) return s;
      return COVER_ITEMS.indexOf(parseInt(r.itemCode)) >= 0 ? s + (parseFloat(r.quantity) || 0) : s;
    }, 0);
    const avgBill = count ? sumBill / count : 0;

    // ต้นทุน: แยกวัตถุดิบโต๊ะเตรียม(กก) ออกจากต้นทุนที่ใช้คิดกำไร
    let sumCost = 0, sumPrepCost = 0;
    details.forEach(r => {
      if (r.void) return;
      const c = (costMap[r.itemCode] ?? 0) * (parseFloat(r.quantity) || 0);
      if (isPrepKgItem(r.itemCode)) sumPrepCost += c;
      else sumCost += c;
    });

    const sumProfit = sumBeforeVat - sumCost;

    return { count, sumAmount, sumBill, sumVat, sumBeforeVat, sumCover, avgBill, sumCost, sumPrepCost, sumProfit };
  }, [salesRaw, detailRaw, selectedOutlet, costMap]);

  // Breakdown ต้นทุนต่อไอเทม (ใช้ในการ์ดต้นทุนแดชบอร์ดที่กดได้)
  const costBreakdown = useMemo(() => {
    const details = selectedOutlet
      ? detailRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : detailRaw;
    const grouped = {};
    details.forEach(r => {
      if (r.void) return;
      if (isPrepKgItem(r.itemCode)) return;   // ต้นทุนโต๊ะเตรียม(กก) แยกไปการ์ดอื่น
      const code = String(r.itemCode || '');
      const unitCost = costMap[code] ?? 0;
      const qty = parseFloat(r.quantity) || 0;
      if (!grouped[code]) grouped[code] = { itemCode: code, name: r.nameThai || r.nameEng || '-', unitCost, qty: 0, totalCost: 0 };
      grouped[code].qty += qty;
      grouped[code].totalCost += unitCost * qty;
    });
    return Object.values(grouped).filter(g => g.totalCost > 0).sort((a, b) => b.totalCost - a.totalCost);
  }, [detailRaw, selectedOutlet, costMap]);

  // Breakdown ต้นทุนโต๊ะเตรียม(กก) — ไอเทมวัตถุดิบ (กก)
  const prepBreakdown = useMemo(() => {
    const details = selectedOutlet
      ? detailRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : detailRaw;
    const grouped = {};
    details.forEach(r => {
      if (r.void) return;
      if (!isPrepKgItem(r.itemCode)) return;
      const code = String(r.itemCode || '');
      const unitCost = costMap[code] ?? 0;
      const qty = parseFloat(r.quantity) || 0;
      if (!grouped[code]) grouped[code] = { itemCode: code, name: r.nameThai || r.nameEng || '-', unitCost, qty: 0, totalCost: 0 };
      grouped[code].qty += qty;
      grouped[code].totalCost += unitCost * qty;
    });
    return Object.values(grouped).sort((a, b) => b.totalCost - a.totalCost);
  }, [detailRaw, selectedOutlet, costMap]);

  const prepStats = useMemo(() => ({
    totalQty: prepBreakdown.reduce((s, c) => s + c.qty, 0),
    totalCost: prepBreakdown.reduce((s, c) => s + c.totalCost, 0),
    lines: prepBreakdown.length,
  }), [prepBreakdown]);

  // รายละเอียดต้นทุนต่อ "วัน+สาขา" (ใช้ตอนกดเซลล์ในตารางรายวัน) — type: 'cost' (หลัก) หรือ 'prep'
  const dailyCostDetail = useMemo(() => {
    const { open, type, date, outletID } = dailyCostModal;
    if (!open) return { rows: [], totalCost: 0, totalQty: 0 };
    const grouped = {};
    detailRaw.forEach(r => {
      if (r.void) return;
      if (dateFromRow(r) !== date || String(r.outletID) !== String(outletID)) return;
      const isPrep = isPrepKgItem(r.itemCode);
      if (type === 'prep' ? !isPrep : isPrep) return;
      const code = String(r.itemCode || '');
      const unitCost = costMap[code] ?? 0;
      const qty = parseFloat(r.quantity) || 0;
      if (!grouped[code]) grouped[code] = { itemCode: code, name: r.nameThai || r.nameEng || '-', unitCost, qty: 0, totalCost: 0 };
      grouped[code].qty += qty;
      grouped[code].totalCost += unitCost * qty;
    });
    let rows = Object.values(grouped).sort((a, b) => b.totalCost - a.totalCost);
    if (type === 'cost') rows = rows.filter(g => g.totalCost > 0);
    return {
      rows,
      totalCost: rows.reduce((s, c) => s + c.totalCost, 0),
      totalQty: rows.reduce((s, c) => s + c.qty, 0),
    };
  }, [dailyCostModal, detailRaw, costMap]);

  // Breakdown รายการโต๊ะ 500/600 ที่ไม่ถูกนำมาคำนวณ (แยกตามโต๊ะ + ไอเทม)
  const excludedBreakdown = useMemo(() => {
    const rows = selectedOutlet
      ? excludedRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : excludedRaw;
    const grouped = {};
    rows.forEach(r => {
      if (r.void) return;
      const code = String(r.itemCode || '');
      const tid = parseInt(r.tableID ?? r.TableID) || 0;
      const reason = isExcludedTable(tid) ? `โต๊ะ ${tid}` : 'ไอเทมเตรียม';
      const key = reason + '|' + code;
      const unitCost = costMap[code] ?? 0;
      const qty = parseFloat(r.quantity) || 0;
      if (!grouped[key]) grouped[key] = { reason, tableID: tid, itemCode: code, name: r.nameThai || r.nameEng || '-', unitCost, qty: 0, totalCost: 0 };
      grouped[key].qty += qty;
      grouped[key].totalCost += unitCost * qty;
    });
    return Object.values(grouped).sort((a, b) => b.totalCost - a.totalCost || b.qty - a.qty);
  }, [excludedRaw, selectedOutlet, costMap]);

  const excludedStats = useMemo(() => ({
    totalQty: excludedBreakdown.reduce((s, c) => s + c.qty, 0),
    totalCost: excludedBreakdown.reduce((s, c) => s + c.totalCost, 0),
    lines: excludedBreakdown.length,
  }), [excludedBreakdown]);

  // Tab 2 (Sales Report) stats
  const salesTabStats = useMemo(() => {
    if (!filteredSales.length) {
      return { totalRevenue: 0, totalBeforeVat: 0, totalCost: 0, totalProfit: 0, totalVat: 0 };
    }
    const filteredCheckIDs = new Set(filteredSales.map(r => String(r.checkID)));
    const totalRevenue = filteredSales.reduce((sum, r) => sum + (parseFloat(r.billTotal) || 0), 0);
    const totalVat = filteredSales.reduce((sum, r) => sum + (parseFloat(r.vat || r.Vat || 0) || 0), 0);
    const totalCost = detailRaw.reduce((sum, r) => {
      if (r.void || !r.chkCheckID) return sum;
      if (isPrepKgItem(r.itemCode)) return sum;   // แยกต้นทุนโต๊ะเตรียม(กก) ออกจากกำไร
      if (filteredCheckIDs.has(String(r.chkCheckID))) {
        const unitCost = costMap[r.itemCode] ?? 0;
        const qty = parseFloat(r.quantity) || 0;
        return sum + (unitCost * qty);
      }
      return sum;
    }, 0);
    const totalBeforeVat = totalRevenue - totalVat;
    const totalProfit = totalBeforeVat - totalCost;
    return { totalRevenue, totalBeforeVat, totalCost, totalProfit, totalVat };
  }, [filteredSales, detailRaw, costMap]);

  // Chart 1: Daily Sales Trend
  const dailyChartData = useMemo(() => {
    const sales = selectedOutlet 
      ? salesRaw.filter(r => String(r.outletID) === String(selectedOutlet)) 
      : salesRaw;

    const grouped = {};
    sales.forEach(r => {
      const d = dateFromRow(r);
      grouped[d] = (grouped[d] || 0) + (parseFloat(r.billTotal) || 0);
    });

    return Object.entries(grouped)
      .map(([date, total]) => ({ date, total }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [salesRaw, selectedOutlet]);

  // Chart 2: Sales by Branch
  const branchChartData = useMemo(() => {
    const grouped = {};
    salesRaw.forEach(r => {
      const b = r.outletID;
      if (!grouped[b]) {
        grouped[b] = { total: 0, covers: 0 };
      }
      grouped[b].total += parseFloat(r.billTotal) || 0;
      grouped[b].covers += parseFloat(r.cover) || 0;
    });

    return Object.entries(grouped)
      .map(([outletID, data]) => ({
        outletID: parseInt(outletID),
        name: outletLabel(outletID),
        total: data.total,
        covers: data.covers
      }));
  }, [salesRaw]);

  const sortedBranchChartData = useMemo(() => {
    return [...branchChartData].sort((a, b) => {
      if (branchChartMode === 'covers') {
        return b.covers - a.covers;
      }
      return b.total - a.total;
    });
  }, [branchChartData, branchChartMode]);

  // Chart 3: Top Selling Menu Items
  const menuChartData = useMemo(() => {
    const details = selectedOutlet
      ? detailRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : detailRaw;

    const grouped = {};
    details.forEach(r => {
      if (r.void) return; // ignore voided transactions
      const name = r.nameThai || 'Unknown';
      grouped[name] = (grouped[name] || 0) + (parseFloat(r.quantity) || 0);
    });

    return Object.entries(grouped)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10);
  }, [detailRaw, selectedOutlet]);

  // Item Search: aggregate all items with total qty, gross, cost
  const itemSummaryData = useMemo(() => {
    const details = selectedOutlet
      ? detailRaw.filter(r => String(r.outletID) === String(selectedOutlet))
      : detailRaw;

    const grouped = {};
    details.forEach(r => {
      if (r.void) return;
      const code = r.itemCode || '-';
      const name = r.nameThai || r.nameEng || '-';
      const nameEng = r.nameEng || '';
      const qty = parseFloat(r.quantity) || 0;
      const gross = parseFloat(r.grossPrice) || 0;
      const unitCost = costMap[code] ?? 0;
      const cost = unitCost * qty;

      if (!grouped[code]) {
        grouped[code] = { itemCode: code, nameThai: name, nameEng, totalQty: 0, totalGross: 0, totalCost: 0 };
      }
      grouped[code].totalQty += qty;
      grouped[code].totalGross += gross;
      grouped[code].totalCost += cost;
    });

    return Object.values(grouped).map(item => ({
      ...item,
      profit: item.totalGross - item.totalCost
    }));
  }, [detailRaw, selectedOutlet, costMap]);

  // Item Search: breakdown of selected item by branch
  const itemBranchData = useMemo(() => {
    if (!selectedItem) return [];
    const details = detailRaw.filter(r =>
      !r.void && String(r.itemCode) === String(selectedItem.itemCode)
    );
    const grouped = {};
    details.forEach(r => {
      const oid = r.outletID;
      const qty = parseFloat(r.quantity) || 0;
      const gross = parseFloat(r.grossPrice) || 0;
      const unitCost = costMap[r.itemCode] ?? 0;
      const cost = unitCost * qty;
      if (!grouped[oid]) {
        grouped[oid] = { outletID: oid, name: outletLabel(oid), totalQty: 0, totalGross: 0, totalCost: 0 };
      }
      grouped[oid].totalQty += qty;
      grouped[oid].totalGross += gross;
      grouped[oid].totalCost += cost;
    });
    return Object.values(grouped)
      .map(b => ({ ...b, profit: b.totalGross - b.totalCost }))
      .sort((a, b) => b.totalQty - a.totalQty);
  }, [detailRaw, selectedItem, costMap]);

  // Filtered + sorted item search list
  const filteredItemSummary = useMemo(() => {
    let d = [...itemSummaryData];
    if (itemSearch && itemSearch.trim()) {
      const q = itemSearch.toLowerCase();
      d = d.filter(r => {
        if (!r) return false;
        const itemCode = r.itemCode ? String(r.itemCode).toLowerCase() : '';
        const nameThai = r.nameThai ? String(r.nameThai).toLowerCase() : '';
        const nameEng = r.nameEng ? String(r.nameEng).toLowerCase() : '';
        return itemCode.includes(q) || nameThai.includes(q) || nameEng.includes(q);
      });
    }

    // Column Filters (Excel-like multiselect)
    const activeF = Object.entries(itemColF).filter(([, vals]) => vals && vals.length > 0);
    if (activeF.length) {
      d = d.filter(row =>
        activeF.every(([key, selectedVals]) => {
          const val = getItemColFilterValue(row, key) || '-';
          return selectedVals.includes(val);
        })
      );
    }

    const { col, asc } = itemSearchSort;
    d.sort((a, b) => {
      let va = a[col], vb = b[col];
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) { va = na; vb = nb; }
      else { va = String(va ?? ''); vb = String(vb ?? ''); }
      return va < vb ? (asc ? -1 : 1) : va > vb ? (asc ? 1 : -1) : 0;
    });
    return d;
  }, [itemSummaryData, itemSearch, itemColF, itemSearchSort]);


  const paymentChartData = useMemo(() => {
    const sales = selectedOutlet 
      ? salesRaw.filter(r => String(r.outletID) === String(selectedOutlet)) 
      : salesRaw;

    const grouped = {};
    sales.forEach(r => {
      const type = r.paidType || 'อื่น ๆ';
      grouped[type] = (grouped[type] || 0) + (parseFloat(r.billTotal) || 0);
    });

    const colors = ['#4f73ff', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#6b7280'];
    return Object.entries(grouped).map(([name, value], i) => ({
      name,
      value,
      color: colors[i % colors.length]
    })).sort((a, b) => b.value - a.value);
  }, [salesRaw, selectedOutlet]);

  // Comparison Chart Data
  const comparisonChartData = useMemo(() => {
    if (compareOutlets.length === 0) return [];
    
    // Group daily totals for each selected branch
    const datesSet = new Set();
    const outletDailyTotals = {}; // { outletID: { date: total } }

    compareOutlets.forEach(oid => {
      outletDailyTotals[oid] = {};
    });

    salesRaw.forEach(r => {
      const date = dateFromRow(r);
      const oid = parseInt(r.outletID);
      if (compareOutlets.includes(oid)) {
        datesSet.add(date);
        outletDailyTotals[oid][date] = (outletDailyTotals[oid][date] || 0) + (parseFloat(r.billTotal) || 0);
      }
    });

    const sortedDates = [...datesSet].sort();
    return sortedDates.map(date => {
      const row = { date };
      compareOutlets.forEach(oid => {
        row[outletLabel(oid)] = outletDailyTotals[oid][date] || 0;
      });
      return row;
    });
  }, [salesRaw, compareOutlets]);

  // Export functions for each chart
  function exportXLSX(data, cols, filename) {
    if (!data.length) return;
    
    const rows = data.map(r => {
      const obj = {};
      cols.forEach(c => {
        let val = r[c.key];
        // Handle special values representation
        if (c.key === 'outletID') {
          val = outletLabel(val);
        } else if (c.key === 'Date') {
          val = dateFromRow(r);
        } else if (c.key === '_date') {
          const t = r.prtOrdTime || r.postTime || r.startTime;
          val = t ? String(t).slice(0, 10) : '';
        } else if (c.key === 'void') {
          val = val ? 'ยกเลิก' : 'ปกติ';
        }
        obj[c.label] = val ?? '';
      });
      return obj;
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, `${filename}_${startDate}_to_${endDate}.xlsx`);
  }

  function exportChartData(chartType) {
    let headers = [];
    let rows = [];
    let filename = '';

    if (chartType === 'daily') {
      headers = ['วันที่', 'ยอดขายรวม (บาท)'];
      rows = dailyChartData.map(r => [r.date, r.total]);
      filename = 'daily_sales';
    } else if (chartType === 'branch') {
      headers = ['รหัสสาขา', 'ชื่อสาขา', 'ยอดขายรวม (บาท)', 'จำนวนลูกค้า (คน)'];
      rows = sortedBranchChartData.map(r => [r.outletID, r.name, r.total, r.covers]);
      filename = branchChartMode === 'sales' ? 'sales_by_branch' : 'covers_by_branch';
    } else if (chartType === 'menu') {
      headers = ['รายการเมนู', 'จำนวนที่ขาย (ชิ้น)'];
      rows = menuChartData.map(r => [r.name, r.qty]);
      filename = 'top_menu_sales';
    } else if (chartType === 'payment') {
      headers = ['ประเภทชำระเงิน', 'ยอดเงินรวม (บาท)'];
      rows = paymentChartData.map(r => [r.name, r.value]);
      filename = 'payment_types';
    } else if (chartType === 'compare') {
      if (!comparisonChartData.length) return;
      const branches = compareOutlets.map(oid => outletLabel(oid));
      headers = ['วันที่', ...branches];
      rows = comparisonChartData.map(r => [
        r.date, 
        ...branches.map(b => r[b] || 0)
      ]);
      filename = 'branch_comparison';
    }

    if (!rows.length) return;

    const sheetData = [headers, ...rows];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, `${filename}_${startDate}_to_${endDate}.xlsx`);
  }

  // Open Modal logic
  async function openDetail(row) {
    const checkID = row.checkID;
    const date = dateFromRow(row);
    setModal({ open: true, checkID, rows: [], loading: true, error: '' });
    
    // Check locally in detailRaw first
    const localMatched = detailRaw.filter(r => String(r.chkCheckID) === String(checkID));
    if (localMatched.length > 0) {
      setModal({ open: true, checkID, rows: localMatched, loading: false, error: '' });
      return;
    }

    // Fallback: Fetch from API for that specific day
    try {
      const res = await fetch(`/api/detail?start=${date}&end=${date}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const list = normalizeArray(json);
      const matched = list.filter(r => String(r.chkCheckID) === String(checkID));
      setModal({ open: true, checkID, rows: matched, loading: false, error: '' });
    } catch (e) {
      setModal({ open: true, checkID, rows: [], loading: false, error: 'ไม่สามารถดึงข้อมูลได้: ' + e.message });
    }
  }

  const handleDailyCellClick = (date, outletID, typeLabel, typeFilterFn) => {
    const matchingBills = salesWithCost.filter(r => {
      const d = dateFromRow(r);
      const matchesDateAndOutlet = d === date && String(r.outletID) === String(outletID);
      return matchesDateAndOutlet && typeFilterFn(r);
    });
    setShowDailyBillsModal({
      open: true,
      title: `${typeLabel} - สาขา ${OUTLETS[outletID] || 'Unknown'} วันที่ ${date}`,
      bills: matchingBills
    });
  };

  const toggleCompareOutlet = (id) => {
    setCompareOutlets(prev => {
      if (prev.includes(id)) {
        return prev.filter(x => x !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const getCompareBranchColor = (index) => {
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444'];
    return colors[index % colors.length];
  };

  if (!isMounted) return null;

  return (
    <>
      <Head>
        <title>NARAI OFFICE</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-800">
        
        {/* SIDEBAR */}
        <aside className={`fixed inset-y-0 left-0 z-20 flex flex-col w-64 bg-slate-900 border-r border-slate-800 text-slate-300 transition-transform duration-300 transform md:relative md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          {/* Logo / Branding */}
          <div className="flex items-center justify-between h-16 px-6 bg-slate-950 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500 font-bold text-white text-lg">N</div>
              <span className="text-xl font-bold tracking-wider text-white">NARAI OFFICE</span>
            </div>
            <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setSidebarOpen(false)}>
              <X size={20} />
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
            {/* ACC Main Menu Accordion */}
            <div className="space-y-1">
              <button 
                onClick={() => setAccOpen(!accOpen)}
                className={`flex items-center justify-between w-full px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${accOpen ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
              >
                <div className="flex items-center gap-3">
                  <Folder size={18} className="text-amber-500" />
                  <span>ACC</span>
                </div>
                {accOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>

              {/* ACC Submenus */}
              {accOpen && (
                <div className="pl-4 space-y-1.5 mt-1 border-l border-slate-800 ml-6">
                  <button 
                    onClick={() => { setActiveTab('dashboard'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <LayoutDashboard size={16} />
                    <span>แดชบอร์ด</span>
                  </button>
                  <button 
                    onClick={() => { setActiveTab('sales'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'sales' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <TrendingUp size={16} />
                    <span>รายงานยอดการขาย</span>
                  </button>
                  <button 
                    onClick={() => { setActiveTab('dailySale'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'dailySale' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <Receipt size={16} />
                    <span>ยอดรายวัน</span>
                  </button>
                  <button 
                    onClick={() => { setActiveTab('details'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'details' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <Layers size={16} />
                    <span>รายละเอียดรายการ</span>
                  </button>
                  <button 
                    onClick={() => { setActiveTab('itemSearch'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'itemSearch' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <Search size={16} />
                    <span>ค้นหารายไอเทม</span>
                  </button>
                </div>
              )}
            </div>

            {/* STOCK Main Menu */}
            <div className="pt-2">
              <button
                onClick={() => setStockOpen(!stockOpen)}
                className={`flex items-center justify-between w-full px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${stockOpen ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
              >
                <div className="flex items-center gap-3">
                  <PackageSearch size={18} className="text-amber-500" />
                  <span>STOCK</span>
                </div>
                {stockOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>

              {stockOpen && (
                <div className="pl-4 space-y-1.5 mt-1 border-l border-slate-800 ml-6">
                  <button
                    onClick={() => { setActiveTab('stockList'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'stockList' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <PackageSearch size={16} />
                    <span>นับสต๊อกและขอเบิก</span>
                  </button>
                  <button
                    onClick={() => { setActiveTab('stockTotal'); if (window.innerWidth < 768) setSidebarOpen(false); }}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${activeTab === 'stockTotal' ? 'bg-amber-500 text-white' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    <Eye size={16} />
                    <span>ดูยอดรวมทุกสาขา</span>
                  </button>
                </div>
              )}
            </div>

            {/* HR Main Menu (Placeholder) */}
            <div className="pt-2">
              <button 
                className="flex items-center justify-between w-full px-4 py-3 rounded-lg text-sm font-semibold transition-colors hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-not-allowed opacity-60"
                onClick={() => alert('เมนู HR ยังไม่เปิดใช้งานในขณะนี้')}
              >
                <div className="flex items-center gap-3">
                  <Users size={18} className="text-slate-400" />
                  <span>HR</span>
                </div>
                <span className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-500 uppercase tracking-wider font-bold">Soon</span>
              </button>
            </div>
          </nav>

          {/* Sidebar Footer */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 text-xs text-slate-500">
            <div>ผู้ใช้งาน: magazine</div>
            <div className="mt-1">เวอร์ชัน: 1.0.0 (Tailwind Build)</div>
          </div>
        </aside>

        {/* MAIN CONTAINER */}
        <main className="flex-1 flex flex-col overflow-hidden">
          
          {/* TOP BAR */}
          <header className="flex items-center justify-between h-16 px-6 bg-white border-b border-slate-100 shadow-sm flex-shrink-0">
            <div className="flex items-center gap-4">
              <button className="md:hidden text-slate-600 hover:text-slate-900" onClick={() => setSidebarOpen(true)}>
                <Menu size={24} />
              </button>
              <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                {activeTab === 'dashboard' && <LayoutDashboard size={20} className="text-amber-600" />}
                {activeTab === 'sales' && <TrendingUp size={20} className="text-amber-600" />}
                {activeTab === 'dailySale' && <Receipt size={20} className="text-amber-600" />}
                {activeTab === 'details' && <Layers size={20} className="text-amber-600" />}
                {activeTab === 'itemSearch' && <Search size={20} className="text-amber-600" />}
                {(activeTab === 'stockList' || activeTab === 'stockTotal') && <PackageSearch size={20} className="text-amber-600" />}
                {activeTab === 'dashboard' ? 'แดชบอร์ดหลัก'
                  : activeTab === 'sales' ? 'รายงานยอดการขาย'
                  : activeTab === 'dailySale' ? 'รายงานยอดรายวันทุกสาขา'
                  : activeTab === 'itemSearch' ? 'ค้นหารายไอเทม'
                  : activeTab === 'stockList' ? 'นับสต๊อกและขอเบิก'
                  : activeTab === 'stockTotal' ? 'ดูยอดรวมทุกสาขา'
                  : 'รายละเอียดรายการ'}
              </h1>
            </div>

            {/* Current Context */}
            <div className="hidden sm:flex items-center gap-2 text-xs font-semibold text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full">
              <Calendar size={14} />
              <span>{loaded ? `${startDate} ถึง ${endDate}` : 'กรุณาค้นหาข้อมูล'}</span>
              {selectedOutlet && (
                <>
                  <span className="text-slate-300">|</span>
                  <Building2 size={14} />
                  <span>สาขา: {outletLabel(selectedOutlet)}</span>
                </>
              )}
            </div>
          </header>

          {/* PAGE CONTENT CONTAINER */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            
            {error && (
              <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-center gap-2">
                <XCircle size={18} />
                <span>{error}</span>
              </div>
            )}

            {/* STOCK VIEWS (จาก Narai-branch — โหมดดูอย่างเดียว) */}
            {activeTab === 'stockList' && <StockList />}
            {activeTab === 'stockTotal' && <StockTotalList />}

            {/* FILTER PANEL */}
            {!(activeTab === 'stockList' || activeTab === 'stockTotal') && (
            <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">กำหนดช่วงวันที่และสาขา</h2>
              <div className="flex flex-col lg:flex-row gap-4 items-end">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-1 w-full">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500">วันที่เริ่มต้น</label>
                    <input 
                      type="date" 
                      value={startDate} 
                      onChange={e => setStartDate(e.target.value)} 
                      className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500">วันที่สิ้นสุด</label>
                    <input 
                      type="date" 
                      value={endDate} 
                      onChange={e => setEndDate(e.target.value)} 
                      className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-500">สาขา (Outlet)</label>
                    <select 
                      value={selectedOutlet} 
                      onChange={e => {
                        setSelectedOutlet(e.target.value);
                        setSalesPage(1);
                        setDetailPage(1);
                        setDailyPage(1);
                      }} 
                      className="border border-slate-200 bg-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                    >
                      <option value="">— ทั้งหมดทุกสาขา —</option>
                      {OUTLET_LIST.map(o => (
                        <option key={o.id} value={String(o.id)}>{o.id} · {o.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex gap-2 w-full lg:w-auto">
                  <button 
                    onClick={loadData} 
                    disabled={loading}
                    className="flex-1 lg:flex-none bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 text-white font-semibold text-sm px-6 py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-amber-100"
                  >
                    {loading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                        <span>กำลังโหลด…</span>
                      </>
                    ) : (
                      <>
                        <Search size={16} />
                        <span>ค้นหาข้อมูล</span>
                      </>
                    )}
                  </button>

                  <button 
                    disabled={!loaded || (
                      activeTab === 'sales' ? filteredSales.length === 0 :
                      activeTab === 'dailySale' ? filteredDailyReport.length === 0 :
                      filteredDetails.length === 0
                    )}
                    onClick={() => {
                      if (activeTab === 'sales') {
                        exportXLSX(filteredSales, SALES_COLUMNS.map(c => ({ key: c.key, label: c.label })), 'sales_report');
                      } else if (activeTab === 'dailySale') {
                        exportXLSX(filteredDailyReport, DAILY_COLUMNS.map(c => ({ key: c.key, label: c.label })), 'daily_sales_report');
                      } else {
                        exportXLSX(filteredDetails, DETAIL_COLUMNS.map(c => ({ key: c.key, label: c.label })), 'detail_report');
                      }
                    }}
                    className="flex-1 lg:flex-none border border-emerald-200 hover:bg-emerald-50 disabled:bg-slate-50 disabled:border-slate-100 disabled:text-slate-400 text-emerald-700 font-semibold text-sm px-5 py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
                  >
                    <Download size={16} />
                    <span>Export Excel</span>
                  </button>
                </div>
              </div>
            </div>
            )}

            {/* TAB CONTENT OR PROGRESS */}
            {loading && loadProgress ? (
              <div className="bg-white border border-amber-100 rounded-2xl p-8 shadow-sm flex flex-col items-center justify-center space-y-5 max-w-md mx-auto my-12 shadow-amber-50">
                <div className="relative flex items-center justify-center">
                  <div className="animate-spin rounded-full h-16 w-16 border-4 border-amber-500 border-t-transparent" />
                  <span className="absolute text-xs font-bold text-amber-600">
                    {Math.round((loadProgress.current / loadProgress.total) * 100)}%
                  </span>
                </div>
                
                <div className="text-center space-y-2">
                  <h4 className="text-sm font-bold text-slate-800">กำลังดาวน์โหลดข้อมูลแยกสาขา...</h4>
                  <p className="text-xs text-slate-500 font-mono bg-slate-50 border border-slate-100 px-3 py-2 rounded-xl">
                    {loadProgress.text}
                  </p>
                </div>
                
                <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className="bg-amber-500 h-full transition-all duration-300 rounded-full" 
                    style={{ width: `${(loadProgress.current / loadProgress.total) * 100}%` }}
                  />
                </div>
                
                <div className="text-[10px] text-slate-400 text-center leading-relaxed">
                  * ดาวน์โหลดทีละ 5 วันเพื่อความเสถียรสูงสุดและป้องกันปัญหาการเชื่อมต่อหลุดกับระบบเครื่องหน้าร้าน
                </div>
              </div>
            ) : (
              <>
                {/* TAB 1: DASHBOARD VIEW */}
                {activeTab === 'dashboard' && (
              <>
                {!loaded ? (
                  <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-100 rounded-2xl shadow-sm text-slate-400">
                    <LayoutDashboard size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                    <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อแสดงผลข้อมูลแดชบอร์ด</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* KPI CARDS */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                      {/* Card 1: Total Sales */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">ยอดขายรวมทั้งหมด</span>
                          <h3 className="text-lg font-bold text-emerald-600 truncate">{fmtMoney(stats.sumBeforeVat)}</h3>
                          <p className="text-[10px] text-slate-400">ก่อน VAT (Bill − VAT)</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-500 flex-shrink-0">
                          <DollarSign size={20} />
                        </div>
                      </div>

                      {/* Card 2: Total Cost (กดดูรายละเอียดได้) */}
                      <button type="button" onClick={() => setCostModalOpen(true)} className="w-full text-left bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between cursor-pointer hover:border-rose-300 hover:shadow-md transition-all">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">ต้นทุนรวมทั้งหมด</span>
                          <h3 className="text-lg font-bold text-rose-600 truncate">{fmtMoney(stats.sumCost)}</h3>
                          <p className="text-[10px] text-rose-500 font-semibold">คลิกดูรายละเอียด →</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-rose-50 flex items-center justify-center text-rose-500 flex-shrink-0">
                          <Layers size={20} />
                        </div>
                      </button>

                      {/* Card 2b: ต้นทุนโต๊ะเตรียม(กก) (กดดูได้) */}
                      <button type="button" onClick={() => setPrepModalOpen(true)} className="w-full text-left bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between cursor-pointer hover:border-orange-300 hover:shadow-md transition-all">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">ต้นทุนโต๊ะเตรียม(กก)</span>
                          <h3 className="text-lg font-bold text-orange-500 truncate">{fmtMoney(stats.sumPrepCost)}</h3>
                          <p className="text-[10px] text-orange-500 font-semibold">{fmtNum(prepStats.totalQty)} กก. • คลิกดู →</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500 flex-shrink-0">
                          <Layers size={20} />
                        </div>
                      </button>

                      {/* Card 3: Profit / Loss */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">กำไร / ขาดทุนสุทธิ</span>
                          <h3 className={`text-lg font-bold truncate ${stats.sumProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {fmtMoney(stats.sumProfit)}
                          </h3>
                          <p className="text-[10px] text-slate-400">ผลกำไรสุทธิ</p>
                        </div>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${stats.sumProfit >= 0 ? 'bg-emerald-50 text-emerald-500' : 'bg-rose-50 text-rose-500'}`}>
                          <TrendingUp size={20} />
                        </div>
                      </div>

                      {/* Card 4: Total Bills */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">จำนวนบิลทั้งหมด</span>
                          <h3 className="text-lg font-bold text-slate-800 truncate">{fmtNum(stats.count)}</h3>
                          <p className="text-[10px] text-slate-400">ใบเสร็จรับเงิน</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500 flex-shrink-0">
                          <Receipt size={20} />
                        </div>
                      </div>

                      {/* Card 5: Avg Bill Value */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">ยอดเฉลี่ยต่อบิล</span>
                          <h3 className="text-lg font-bold text-amber-600 truncate">{fmtMoney(stats.avgBill)}</h3>
                          <p className="text-[10px] text-slate-400">เฉลี่ยต่อบิล</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500 flex-shrink-0">
                          <TrendingUp size={20} />
                        </div>
                      </div>

                      {/* Card 6: Total Covers */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">จำนวนลูกค้าทั้งหมด</span>
                          <h3 className="text-lg font-bold text-slate-800 truncate">{fmtNum(stats.sumCover)}</h3>
                          <p className="text-[10px] text-slate-400">คน (Covers)</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500 flex-shrink-0">
                          <Users size={20} />
                        </div>
                      </div>

                      {/* Card 7: Excluded tables 500/600 (กดดูได้) */}
                      <button type="button" onClick={() => setExcludedModalOpen(true)} className="w-full text-left bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center justify-between cursor-pointer hover:border-slate-300 hover:shadow-md transition-all">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">รายการไม่นับคำนวณ</span>
                          <h3 className="text-lg font-bold text-slate-500 truncate">{fmtMoney(excludedStats.totalCost)}</h3>
                          <p className="text-[10px] text-slate-500 font-semibold">{fmtNum(excludedStats.totalQty)} ชิ้น • คลิกดู →</p>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                          <Layers size={20} />
                        </div>
                      </button>
                    </div>

                    {/* CHART PANELS GRID */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Chart 1: Daily Sales Trend */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm flex flex-col">
                        <div className="flex items-center justify-between mb-6">
                          <div>
                            <h3 className="text-sm font-bold text-slate-800">ยอดขายรายวัน</h3>
                            <p className="text-xs text-slate-400">แนวโน้มรายได้การขายในแต่ละวัน</p>
                          </div>
                          <button 
                            onClick={() => exportChartData('daily')}
                            className="p-2 border border-slate-100 rounded-xl hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-colors"
                            title="Export to Excel"
                          >
                            <Download size={16} />
                          </button>
                        </div>
                        <div className="h-72 w-full">
                          {dailyChartData.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-slate-400 text-xs">ไม่มีข้อมูลยอดขายรายวัน</div>
                          ) : (
                            <ResponsiveContainer width="100%" height="100%">
                              <AreaChart data={dailyChartData}>
                                <defs>
                                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#4f73ff" stopOpacity={0.2}/>
                                    <stop offset="95%" stopColor="#4f73ff" stopOpacity={0}/>
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
                                <YAxis stroke="#94a3b8" fontSize={11} tickFormatter={v => '฿' + v.toLocaleString()} />
                                <Tooltip formatter={v => ['฿' + v.toLocaleString(), 'ยอดขาย']} labelStyle={{ color: '#64748b' }} />
                                <Area type="monotone" dataKey="total" stroke="#4f73ff" strokeWidth={2} fillOpacity={1} fill="url(#colorSales)" />
                              </AreaChart>
                            </ResponsiveContainer>
                          )}
                        </div>
                      </div>

                      {/* Chart 2: Sales by Branch */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm flex flex-col">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                          <div>
                            <h3 className="text-sm font-bold text-slate-800">
                              {branchChartMode === 'sales' ? 'ยอดขายตามสาขา' : 'จำนวนลูกค้าตามสาขา'}
                            </h3>
                            <p className="text-xs text-slate-400">
                              {branchChartMode === 'sales' ? 'เปรียบเทียบยอดขายรวมในทุกสาขา' : 'เปรียบเทียบจำนวนลูกค้า (Covers) ในทุกสาขา'}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 self-end sm:self-auto">
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs">
                              <button
                                onClick={() => setBranchChartMode('sales')}
                                className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${branchChartMode === 'sales' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                              >
                                ยอดขาย
                              </button>
                              <button
                                onClick={() => setBranchChartMode('covers')}
                                className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${branchChartMode === 'covers' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                              >
                                จำนวนหัว
                              </button>
                            </div>
                            <button 
                              onClick={() => exportChartData('branch')}
                              className="p-2 border border-slate-100 rounded-xl hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-colors flex-shrink-0"
                              title="Export to Excel"
                            >
                              <Download size={16} />
                            </button>
                          </div>
                        </div>
                        <div className="h-72 w-full">
                          {branchChartData.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-slate-400 text-xs">
                              {branchChartMode === 'sales' ? 'ไม่มีข้อมูลยอดขายรายสาขา' : 'ไม่มีข้อมูลจำนวนลูกค้าสาขา'}
                            </div>
                          ) : (
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={sortedBranchChartData.slice(0, 10)}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} tickFormatter={v => v.split(' · ')[1] || v} />
                                <YAxis 
                                  stroke="#94a3b8" 
                                  fontSize={11} 
                                  tickFormatter={v => branchChartMode === 'sales' ? '฿' + v.toLocaleString() : v.toLocaleString()} 
                                />
                                <Tooltip 
                                  formatter={v => branchChartMode === 'sales' 
                                    ? ['฿' + v.toLocaleString(), 'ยอดขายรวม'] 
                                    : [v.toLocaleString() + ' คน', 'จำนวนลูกค้า (Covers)']
                                  } 
                                />
                                <Bar 
                                  dataKey={branchChartMode === 'sales' ? 'total' : 'covers'} 
                                  fill={branchChartMode === 'sales' ? '#10b981' : '#f59e0b'} 
                                  radius={[4, 4, 0, 0]}
                                >
                                  {sortedBranchChartData.slice(0, 10).map((entry, index) => (
                                    <Cell 
                                      key={`cell-${index}`} 
                                      fill={branchChartMode === 'sales' 
                                        ? (index % 2 === 0 ? '#10b981' : '#34d399') 
                                        : (index % 2 === 0 ? '#f59e0b' : '#fbbf24')
                                      } 
                                    />
                                  ))}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          )}
                        </div>
                      </div>

                      {/* Chart 3: Top Selling Menu Items */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm flex flex-col">
                        <div className="flex items-center justify-between mb-6">
                          <div>
                            <h3 className="text-sm font-bold text-slate-800">10 อันดับเมนูขายดี</h3>
                            <p className="text-xs text-slate-400">จำนวนยอดปริมาณรายการเมนูยอดฮิต (หน่วย: ชิ้น)</p>
                          </div>
                          <button 
                            onClick={() => exportChartData('menu')}
                            className="p-2 border border-slate-100 rounded-xl hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-colors"
                            title="Export to Excel"
                          >
                            <Download size={16} />
                          </button>
                        </div>
                        <div className="h-72 w-full">
                          {menuChartData.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-slate-400 text-xs">ไม่มีข้อมูลยอดรายการสินค้า</div>
                          ) : (
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={menuChartData} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                <XAxis type="number" stroke="#94a3b8" fontSize={11} />
                                <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={10} width={100} />
                                <Tooltip formatter={v => [v.toLocaleString() + ' ชิ้น', 'จำนวน']} />
                                <Bar dataKey="qty" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={12} />
                              </BarChart>
                            </ResponsiveContainer>
                          )}
                        </div>
                      </div>

                      {/* Chart 4: Payment Types */}
                      <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm flex flex-col">
                        <div className="flex items-center justify-between mb-6">
                          <div>
                            <h3 className="text-sm font-bold text-slate-800">สัดส่วนประเภทชำระเงิน</h3>
                            <p className="text-xs text-slate-400">วิเคราะห์พฤติกรรมการจ่ายเงินของลูกค้า</p>
                          </div>
                          <button 
                            onClick={() => exportChartData('payment')}
                            className="p-2 border border-slate-100 rounded-xl hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-colors"
                            title="Export to Excel"
                          >
                            <Download size={16} />
                          </button>
                        </div>
                        <div className="flex flex-col sm:flex-row items-center justify-center h-72 gap-6">
                          {paymentChartData.length === 0 ? (
                            <div className="text-slate-400 text-xs">ไม่มีข้อมูลประเภทชำระ</div>
                          ) : (
                            <>
                              <div className="w-1/2 h-full">
                                <ResponsiveContainer width="100%" height="100%">
                                  <PieChart>
                                    <Pie
                                      data={paymentChartData}
                                      cx="50%"
                                      cy="50%"
                                      innerRadius={60}
                                      outerRadius={80}
                                      paddingAngle={3}
                                      dataKey="value"
                                    >
                                      {paymentChartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                      ))}
                                    </Pie>
                                    <Tooltip formatter={v => ['฿' + v.toLocaleString(), 'จำนวน']} />
                                  </PieChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="flex flex-col gap-2 w-full sm:w-1/2 text-xs">
                                {paymentChartData.map((entry, i) => (
                                  <div key={i} className="flex items-center justify-between border-b border-slate-50 pb-1">
                                    <div className="flex items-center gap-2">
                                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                                      <span className="font-semibold text-slate-600">{entry.name}</span>
                                    </div>
                                    <span className="text-slate-800 font-bold">{fmtMoney(entry.value)}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* BRANCH COMPARISON PANEL */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm">
                      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
                        <div>
                          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                            <ArrowRightLeft size={16} className="text-amber-600" />
                            เปรียบเทียบสาขา
                          </h3>
                          <p className="text-xs text-slate-400">เลือกสาขาด้านล่างเพื่อเปรียบเทียบยอดขายรายวันซ้อนทับกัน</p>
                        </div>
                        <button 
                          disabled={compareOutlets.length === 0}
                          onClick={() => exportChartData('compare')}
                          className="self-start md:self-auto flex items-center gap-1.5 px-3 py-1.5 border border-slate-100 hover:bg-slate-50 text-xs font-semibold text-slate-500 hover:text-slate-800 rounded-xl transition-all"
                        >
                          <Download size={14} />
                          <span>Export ผลเปรียบเทียบ</span>
                        </button>
                      </div>

                      {/* Outlet checklist checkboxes */}
                      <div className="flex flex-wrap gap-2 mb-6">
                        {OUTLET_LIST.map(o => {
                          const active = compareOutlets.includes(o.id);
                          return (
                            <button
                              key={o.id}
                              onClick={() => toggleCompareOutlet(o.id)}
                              className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition-all flex items-center gap-1.5 ${
                                active 
                                  ? 'bg-amber-600 text-white border-amber-600 shadow-md shadow-amber-100' 
                                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                              }`}
                            >
                              <span>{o.id} · {o.name}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Trend compare chart */}
                      <div className="h-80 w-full">
                        {compareOutlets.length === 0 ? (
                          <div className="flex items-center justify-center h-full text-slate-400 text-xs">กรุณาเลือกสาขาอย่างน้อย 1 สาขาเพื่อแสดงกราฟเปรียบเทียบ</div>
                        ) : comparisonChartData.length === 0 ? (
                          <div className="flex items-center justify-center h-full text-slate-400 text-xs">ไม่มีข้อมูลการขายในสาขาที่เลือก</div>
                        ) : (
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={comparisonChartData}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                              <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
                              <YAxis stroke="#94a3b8" fontSize={11} tickFormatter={v => '฿' + v.toLocaleString()} />
                              <Tooltip formatter={v => ['฿' + v.toLocaleString(), 'ยอดบิลรวม']} />
                              <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                              {compareOutlets.map((oid, idx) => (
                                <Line
                                  key={oid}
                                  type="monotone"
                                  dataKey={outletLabel(oid)}
                                  stroke={getCompareBranchColor(idx)}
                                  strokeWidth={2}
                                  dot={{ r: 3 }}
                                />
                              ))}
                            </LineChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* TAB 2: SALES REPORT VIEW */}
            {activeTab === 'sales' && (
              <div className="flex flex-col gap-6">
                {loaded && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
                    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
                        <DollarSign size={22} />
                      </div>
                      <div>
                        <span className="text-xs text-slate-400 font-semibold block">ยอดขายรวม VAT</span>
                        <span className="text-xl font-bold text-slate-800 mt-0.5 block">{fmtMoney(salesTabStats.totalRevenue)} บาท</span>
                      </div>
                    </div>
                    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center flex-shrink-0">
                        <DollarSign size={22} />
                      </div>
                      <div>
                        <span className="text-xs text-slate-400 font-semibold block">ยอดขายก่อน VAT</span>
                        <span className="text-xl font-bold text-slate-800 mt-0.5 block">{fmtMoney(salesTabStats.totalBeforeVat)} บาท</span>
                      </div>
                    </div>
                    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0">
                        <Receipt size={22} />
                      </div>
                      <div>
                        <span className="text-xs text-slate-400 font-semibold block">ภาษีมูลค่าเพิ่ม (VAT) รวม</span>
                        <span className="text-xl font-bold text-slate-800 mt-0.5 block">{fmtMoney(salesTabStats.totalVat)} บาท</span>
                      </div>
                    </div>
                    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center flex-shrink-0">
                        <Layers size={22} />
                      </div>
                      <div>
                        <span className="text-xs text-slate-400 font-semibold block">ต้นทุนรวมทั้งหมด</span>
                        <span className="text-xl font-bold text-slate-800 mt-0.5 block">{fmtMoney(salesTabStats.totalCost)} บาท</span>
                      </div>
                    </div>
                    <div className={`bg-white border border-slate-100 rounded-2xl p-5 shadow-sm flex items-center gap-4 border-l-4 ${salesTabStats.totalProfit >= 0 ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${salesTabStats.totalProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                        <TrendingUp size={22} />
                      </div>
                      <div>
                        <span className="text-xs text-slate-400 font-semibold block">ผลกำไร / ขาดทุนสุทธิ</span>
                        <span className={`text-xl font-bold mt-0.5 block ${salesTabStats.totalProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {fmtMoney(salesTabStats.totalProfit)} บาท
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                  <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800">ตารางรายการขาย</h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {loaded ? `พบบันทึกธุรกรรมบิล ${filteredSales.length.toLocaleString('th-TH')} รายการ` : 'รอผลลัพธ์การโหลดข้อมูล'}
                      </p>
                    </div>
                    {loaded && (
                      <div className="relative w-full sm:w-64">
                        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input 
                          type="text" 
                          placeholder="ค้นหาบิลด่วน..." 
                          value={salesSearch}
                          onChange={e => { setSalesSearch(e.target.value); setSalesPage(1); }}
                          className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                    )}
                  </div>

                  {!loaded ? (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <TrendingUp size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                      <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อแสดงผลรายการขาย</p>
                    </div>
                  ) : (
                    <>
                      <div className="overflow-auto max-h-[70vh] min-h-[480px] w-full">
                        <table className="lock-table w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold">
                              <th className="px-4 py-3 text-slate-600">ตัวช่วย</th>
                              {SALES_COLUMNS.map(c => {
                                const isSorted = salesSort.col === c.key;
                                return (
                                  <th 
                                    key={c.key} 
                                    onClick={() => setSalesSort({ col: c.key, asc: salesSort.col === c.key ? !salesSort.asc : true })}
                                    className="px-4 py-3 text-slate-600 cursor-pointer hover:bg-slate-100 hover:text-amber-600 transition-colors whitespace-nowrap"
                                  >
                                    <div className="flex items-center gap-1">
                                      <span>{c.label}</span>
                                      {isSorted && (<span>{salesSort.asc ? '▲' : '▼'}</span>)}
                                    </div>
                                  </th>
                                );
                              })}
                            </tr>
                            <tr className="bg-slate-50/50 border-b border-slate-100">
                              <th className="px-4 py-1.5" />
                              {SALES_COLUMNS.map(c => (
                                <th key={c.key} className="px-2 py-1.5">
                                  <ExcelFilterDropdown
                                    columnKey={c.key}
                                    label={c.label}
                                    value={salesColF[c.key] || []}
                                    onChange={val => {
                                      setSalesColF(prev => ({ ...prev, [c.key]: val }));
                                      setSalesPage(1);
                                    }}
                                    dataset={salesWithCost}
                                    getValFn={getColFilterValue}
                                  />
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 text-slate-700">
                            {filteredSales.length === 0 ? (
                              <tr>
                                <td colSpan={SALES_COLUMNS.length + 1} className="py-20 text-center text-slate-400">
                                  <div className="flex flex-col items-center justify-center">
                                    <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                                    <p className="text-sm">ไม่พบข้อมูลตามเงื่อนไขที่ระบุ</p>
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              filteredSales.slice((salesPage - 1) * PAGE_SIZE, salesPage * PAGE_SIZE).map((row, i) => (
                                <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                  <td className="px-4 py-2.5">
                                    <button 
                                      onClick={() => openDetail(row)}
                                      className="flex items-center gap-1 px-2.5 py-1 border border-amber-200 hover:bg-amber-50 text-amber-700 font-semibold rounded-lg text-[10px] transition-colors"
                                    >
                                      <Eye size={12} />
                                      <span>ดูบิล</span>
                                    </button>
                                  </td>
                                  <td className="px-4 py-2.5 whitespace-nowrap">{dateFromRow(row)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono">{row.checkID}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{outletLabel(row.outletID)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-center font-mono text-slate-600">{row.tableID ?? '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{row.cashierName || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{row.waiterName || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-emerald-600 font-semibold">{fmtMoney(row.amount)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-600 font-semibold">{fmtMoney(row.beforeVat)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-500">{fmtMoney(row.vat)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-amber-600 font-bold">{fmtMoney(row.billTotal)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-rose-600 font-semibold">{fmtMoney(row.billCost)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap">
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                      String(row.paidType).toLowerCase().includes('cash') || String(row.paidType).includes('สด')
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : String(row.paidType).toLowerCase().includes('credit') || String(row.paidType).includes('บัตร')
                                        ? 'bg-amber-50 text-amber-700'
                                        : 'bg-amber-50 text-amber-700'
                                    }`}>
                                      {row.paidType || '-'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-700">{row.memberTel || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">{fmtNum(row.cover)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">{fmtNum(row.coverAd)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono">{fmtNum(row.coverAll)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{row.startTime || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{row.date || '-'}</td>
                                  <td className="px-4 py-2.5 max-w-[200px] truncate text-slate-500" title={row.checkDesc}>{row.checkDesc || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-400">{row.orderID || '-'}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                      {/* Pagination */}
                      <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                        <span>
                          แสดง {filteredSales.length === 0 ? 0 : (salesPage - 1) * PAGE_SIZE + 1}–{Math.min(salesPage * PAGE_SIZE, filteredSales.length)} จาก {filteredSales.length.toLocaleString('th-TH')} บิล
                        </span>
                        <div className="flex gap-1.5">
                          <button 
                            disabled={salesPage === 1}
                            onClick={() => setSalesPage(p => p - 1)}
                            className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                          >
                            <ChevronLeft size={16} />
                          </button>
                          <span className="flex items-center px-3 font-semibold text-slate-700">หน้า {filteredSales.length === 0 ? 0 : salesPage} จาก {Math.ceil(filteredSales.length / PAGE_SIZE)}</span>
                          <button 
                            disabled={salesPage >= Math.ceil(filteredSales.length / PAGE_SIZE)}
                            onClick={() => setSalesPage(p => p + 1)}
                            className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: DETAILS REPORT VIEW */}
            {activeTab === 'details' && (
              <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">ตารางรายละเอียดสินค้า</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {loaded ? `พบบันทึกสินค้าขาย ${filteredDetails.length.toLocaleString('th-TH')} รายการ` : 'รอผลลัพธ์การโหลดข้อมูล'}
                    </p>
                  </div>
                  {loaded && (
                    <div className="relative w-full sm:w-64">
                      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input 
                        type="text" 
                        placeholder="ค้นหาชื่ออาหาร หรือ รหัสสินค้า..." 
                        value={detailSearch}
                        onChange={e => { setDetailSearch(e.target.value); setDetailPage(1); }}
                        className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                  )}
                </div>

                {!loaded ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <Layers size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                    <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อแสดงผลรายละเอียดสินค้า</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-auto max-h-[70vh] min-h-[480px] w-full">
                      <table className="lock-table w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold">
                            {DETAIL_COLUMNS.map(c => {
                              const isSorted = detailSort.col === c.key;
                              return (
                                <th 
                                  key={c.key} 
                                  onClick={() => setDetailSort({ col: c.key, asc: detailSort.col === c.key ? !detailSort.asc : true })}
                                  className="px-4 py-3 text-slate-600 cursor-pointer hover:bg-slate-100 hover:text-amber-600 transition-colors whitespace-nowrap"
                                >
                                  <div className="flex items-center gap-1">
                                    <span>{c.label}</span>
                                    {isSorted && (<span>{detailSort.asc ? '▲' : '▼'}</span>)}
                                  </div>
                                </th>
                              );
                            })}
                          </tr>
                          <tr className="bg-slate-50/50 border-b border-slate-100">
                            {DETAIL_COLUMNS.map(c => (
                              <th key={c.key} className="px-2 py-1.5">
                                <ExcelFilterDropdown
                                  columnKey={c.key}
                                  label={c.label}
                                  value={detailColF[c.key] || []}
                                  onChange={val => {
                                    setDetailColF(prev => ({ ...prev, [c.key]: val }));
                                    setDetailPage(1);
                                  }}
                                  dataset={detailsWithCost}
                                  getValFn={getColFilterValue}
                                />
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700">
                          {filteredDetails.length === 0 ? (
                            <tr>
                              <td colSpan={DETAIL_COLUMNS.length} className="py-20 text-center text-slate-400">
                                <div className="flex flex-col items-center justify-center">
                                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                                  <p className="text-sm">ไม่พบข้อมูลตามเงื่อนไขที่ระบุ</p>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            filteredDetails.slice((detailPage - 1) * PAGE_SIZE, detailPage * PAGE_SIZE).map((row, i) => {
                              const isVoided = row.void;
                              const isExcluded = isExcludedTable(row.tableID ?? row.TableID) || isExcludedItem(row.itemCode);
                              return (
                                <tr key={i} className={`hover:bg-slate-50/50 transition-colors ${isVoided ? 'row-void bg-rose-50/20' : isExcluded ? 'bg-amber-50/40' : ''}`}>
                                  <td className="px-4 py-2.5 whitespace-nowrap">{row.prtOrdTime ? row.prtOrdTime.slice(0, 10) : '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono">{row.chkCheckID}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{outletLabel(row.outletID)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-500">{row.itemCode || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-semibold text-slate-800">
                                    {row.nameThai || '-'}
                                    {isExcluded && <span className="ml-2 text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">ไม่นับ</span>}
                                  </td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-semibold">{fmtNum(row.quantity)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-500">{fmtMoney(row.unitPrice)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-emerald-600 font-bold">{fmtMoney(row.grossPrice)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-rose-500">{fmtMoney(row.unitCost)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-rose-600 font-bold">{fmtMoney(row.lineCost)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-400">{fmtMoney(row.tax)}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-center font-mono">{row.tableID || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{row.prtOrdTime || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap">
                                    {isVoided ? (
                                      <span className="flex items-center gap-1 text-rose-600 font-semibold">
                                        <XCircle size={14} />
                                        <span>ยกเลิก</span>
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                                        <CheckCircle size={14} />
                                        <span>ปกติ</span>
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{row.voidTime || '-'}</td>
                                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-400">{row.orderID || '-'}</td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                        <tfoot>
                          <tr className="bg-amber-50/50 border-t-2 border-amber-500 font-bold text-slate-800">
                            <td className="px-4 py-3">ยอดรวมทั้งหมด</td>
                            <td colSpan={4} />
                            <td className="px-4 py-3 text-right font-mono">
                              {fmtNum(filteredDetails.reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0))}
                            </td>
                            <td />
                            <td className="px-4 py-3 text-right font-mono text-amber-700">
                              {fmtMoney(filteredDetails.reduce((s, r) => s + (parseFloat(r.grossPrice) || 0), 0))}
                            </td>
                            <td />
                            <td className="px-4 py-3 text-right font-mono text-rose-700">
                              {fmtMoney(filteredDetails.reduce((s, r) => s + (r.lineCost || 0), 0))}
                            </td>
                            <td colSpan={6} />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    {/* Pagination */}
                    <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        แสดง {filteredDetails.length === 0 ? 0 : (detailPage - 1) * PAGE_SIZE + 1}–{Math.min(detailPage * PAGE_SIZE, filteredDetails.length)} จาก {filteredDetails.length.toLocaleString('th-TH')} รายการสินค้า
                      </span>
                      <div className="flex gap-1.5">
                        <button 
                          disabled={detailPage === 1}
                          onClick={() => setDetailPage(p => p - 1)}
                          className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="flex items-center px-3 font-semibold text-slate-700">หน้า {filteredDetails.length === 0 ? 0 : detailPage} จาก {Math.ceil(filteredDetails.length / PAGE_SIZE)}</span>
                        <button 
                          disabled={detailPage >= Math.ceil(filteredDetails.length / PAGE_SIZE)}
                          onClick={() => setDetailPage(p => p + 1)}
                          className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* TAB 4: DAILY SALES REPORT VIEW */}
            {activeTab === 'dailySale' && (
              <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">ตารางรายงานยอดรายวันทุกสาขา</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {loaded ? `พบบันทึกยอดขายรายวัน ${filteredDailyReport.length.toLocaleString('th-TH')} รายการ` : 'รอผลลัพธ์การโหลดข้อมูล'}
                    </p>
                  </div>
                  {loaded && (
                    <div className="relative w-full sm:w-64">
                      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input 
                        type="text" 
                        placeholder="ค้นหาวันที่หรือสาขา..." 
                        value={dailySearch}
                        onChange={e => { setDailySearch(e.target.value); setDailyPage(1); }}
                        className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                  )}
                </div>

                {!loaded ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <Receipt size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                    <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อแสดงรายงานยอดรายวัน</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-auto max-h-[70vh] min-h-[480px] w-full">
                      <table className="lock-table w-full text-left text-[11px] border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold">
                            {DAILY_COLUMNS.map(c => {
                              const isSorted = dailySort.col === c.key;
                              return (
                                <th 
                                  key={c.key} 
                                  onClick={() => setDailySort({ col: c.key, asc: dailySort.col === c.key ? !dailySort.asc : true })}
                                  className="px-3 py-2.5 text-slate-600 cursor-pointer hover:bg-slate-100 hover:text-amber-600 transition-colors whitespace-nowrap"
                                >
                                  <div className="flex items-center gap-0.5">
                                    <span>{c.label}</span>
                                    {isSorted && (<span>{dailySort.asc ? '▲' : '▼'}</span>)}
                                  </div>
                                </th>
                              );
                            })}
                          </tr>
                          <tr className="bg-slate-50/50 border-b border-slate-100">
                            {DAILY_COLUMNS.map(c => (
                              <th key={c.key} className="px-1.5 py-1">
                                <ExcelFilterDropdown
                                  columnKey={c.key}
                                  label={c.label}
                                  value={dailyColF[c.key] || []}
                                  onChange={val => {
                                    setDailyColF(prev => ({ ...prev, [c.key]: val }));
                                    setDailyPage(1);
                                  }}
                                  dataset={dailyReportData}
                                  getValFn={getDailyColFilterValue}
                                />
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                          {filteredDailyReport.length === 0 ? (
                            <tr>
                              <td colSpan={DAILY_COLUMNS.length} className="py-20 text-center text-slate-400">
                                <div className="flex flex-col items-center justify-center">
                                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                                  <p className="text-sm">ไม่พบข้อมูลตามเงื่อนไขที่ระบุ</p>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            filteredDailyReport.slice((dailyPage - 1) * PAGE_SIZE, dailyPage * PAGE_SIZE).map((row, i) => (
                              <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                <td className="px-3 py-2 whitespace-nowrap">{row.date}</td>
                                <td className="px-3 py-2 whitespace-nowrap font-mono">{row.outletID}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-slate-900 font-semibold">{row.name}</td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'ยอดขาย Dine-In', r => {
                                    const t = parseInt(r.tableID || r.TableID || 0);
                                    return t !== 300 && t !== 400 && t !== 401;
                                  })}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-amber-600 hover:text-amber-800 hover:underline font-bold transition-all"
                                >
                                  {fmtMoney(row.dineIn)}
                                </td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'ยอดขาย Take-Home', r => parseInt(r.tableID || r.TableID || 0) === 300)}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-amber-600 hover:text-amber-800 hover:underline font-bold transition-all"
                                >
                                  {fmtMoney(row.takeHome)}
                                </td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'ยอดขาย Delivery', r => {
                                    const t = parseInt(r.tableID || r.TableID || 0);
                                    return t === 400 || t === 401;
                                  })}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-amber-600 hover:text-amber-800 hover:underline font-bold transition-all"
                                >
                                  {fmtMoney(row.delivery)}
                                </td>

                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono">{fmtMoney(row.serviceChg)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-emerald-600 font-semibold">{fmtMoney(row.netSales)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-slate-500">{fmtMoney(row.vat)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-amber-600 font-bold">{fmtMoney(row.grossSales)}</td>
                                {['cash','credit','qrCredit','qr','oc','grab','robinhood','shopee','lineMan','voucher','alipay','wechat','copay','catering'].map(k => (
                                  <td key={k} className="px-3 py-2 whitespace-nowrap text-right font-mono">
                                    <button onClick={() => handleDailyCellClick(row.date, row.outletID, PAYMENT_CELLS[k].label, PAYMENT_CELLS[k].fn)} className="hover:underline cursor-pointer">{fmtMoney(row[k])}</button>
                                  </td>
                                ))}
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-amber-700 font-bold">
                                  <button onClick={() => handleDailyCellClick(row.date, row.outletID, PAYMENT_CELLS.totalSales.label, PAYMENT_CELLS.totalSales.fn)} className="hover:underline cursor-pointer">{fmtMoney(row.totalSales)}</button>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.billCount)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.totalCovers)}</td>
                                
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'จำนวนบิล Take-Home', r => parseInt(r.tableID || r.TableID || 0) === 300)}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-slate-700 hover:text-slate-900 hover:underline font-semibold transition-all"
                                >
                                  {fmtNum(row.takeHomeBills)}
                                </td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'ต้นทุน Take-Home', r => parseInt(r.tableID || r.TableID || 0) === 300)}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-rose-600 hover:text-rose-800 hover:underline font-semibold transition-all"
                                >
                                  {fmtMoney(row.takeHomeCost)}
                                </td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'จำนวนบิล Delivery', r => {
                                    const t = parseInt(r.tableID || r.TableID || 0);
                                    return t === 400 || t === 401;
                                  })}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-slate-700 hover:text-slate-900 hover:underline font-semibold transition-all"
                                >
                                  {fmtNum(row.deliveryBills)}
                                </td>
                                <td 
                                  onClick={() => handleDailyCellClick(row.date, row.outletID, 'ต้นทุน Delivery', r => {
                                    const t = parseInt(r.tableID || r.TableID || 0);
                                    return t === 400 || t === 401;
                                  })}
                                  className="px-3 py-2 whitespace-nowrap text-right font-mono cursor-pointer text-rose-600 hover:text-rose-800 hover:underline font-semibold transition-all"
                                >
                                  {fmtMoney(row.deliveryCost)}
                                </td>

                                {/* Buffet columns */}
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.buffet259Qty)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-emerald-600">{fmtMoney(row.buffet259Amt)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.buffet359Qty)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-emerald-600">{fmtMoney(row.buffet359Amt)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.kid159Qty)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-emerald-600">{fmtMoney(row.kid159Amt)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.kid109Qty)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-emerald-600">{fmtMoney(row.kid109Amt)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{fmtNum(row.kidFreeQty)}</td>

                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-rose-600">
                                  <button onClick={() => setDailyCostModal({ open: true, type: 'cost', date: row.date, outletID: row.outletID })} className="hover:underline cursor-pointer">{fmtMoney(row.totalCost)}</button>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-orange-500">
                                  <button onClick={() => setDailyCostModal({ open: true, type: 'prep', date: row.date, outletID: row.outletID })} className="hover:underline cursor-pointer">{fmtMoney(row.prepCost)}</button>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-semibold text-slate-700">{row.costPct.toFixed(2)}%</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                        <tfoot>
                          <tr className="bg-amber-50/50 border-t-2 border-amber-500 font-bold text-slate-800">
                            <td className="px-3 py-2.5">ยอดรวมทั้งหมด</td>
                            <td colSpan={2} />
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.dineIn, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.takeHome, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.delivery, 0))}</td>
                            
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.serviceChg, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.netSales, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.vat, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-amber-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.grossSales, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.cash, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.credit, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.qrCredit, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.qr, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.oc, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.grab, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.robinhood, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.shopee, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.lineMan, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.voucher, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.alipay, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.wechat, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.copay, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.catering, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-amber-800 font-bold">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.totalSales, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.billCount, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.totalCovers, 0))}</td>
                            
                            {/* Moved columns totals */}
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.takeHomeBills, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-rose-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.takeHomeCost, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.deliveryBills, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-rose-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.deliveryCost, 0))}</td>

                            {/* Buffet totals */}
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.buffet259Qty, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.buffet259Amt, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.buffet359Qty, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.buffet359Amt, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.kid159Qty, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.kid159Amt, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.kid109Qty, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.kid109Amt, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(filteredDailyReport.reduce((s, r) => s + r.kidFreeQty, 0))}</td>

                            <td className="px-3 py-2.5 text-right font-mono font-bold text-rose-800">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.totalCost, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-orange-600">{fmtMoney(filteredDailyReport.reduce((s, r) => s + r.prepCost, 0))}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-800">
                              {(() => {
                                const totSales = filteredDailyReport.reduce((s, r) => s + r.netSales, 0);
                                const totCost = filteredDailyReport.reduce((s, r) => s + r.totalCost, 0);
                                const totPct = totSales > 0 ? (totCost / totSales) * 100 : 0;
                                return `${totPct.toFixed(2)}%`;
                              })()}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    {/* Pagination */}
                    <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        แสดง {filteredDailyReport.length === 0 ? 0 : (dailyPage - 1) * PAGE_SIZE + 1}–{Math.min(dailyPage * PAGE_SIZE, filteredDailyReport.length)} จาก {filteredDailyReport.length.toLocaleString('th-TH')} รายการ
                      </span>
                      <div className="flex gap-1.5">
                        <button 
                          disabled={dailyPage === 1}
                          onClick={() => setDailyPage(p => p - 1)}
                          className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="flex items-center px-3 font-semibold text-slate-700">หน้า {filteredDailyReport.length === 0 ? 0 : dailyPage} จาก {Math.ceil(filteredDailyReport.length / PAGE_SIZE)}</span>
                        <button 
                          disabled={dailyPage >= Math.ceil(filteredDailyReport.length / PAGE_SIZE)}
                          onClick={() => setDailyPage(p => p + 1)}
                          className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* TAB 5: ITEM SEARCH */}
            {!loading && activeTab === 'itemSearch' && (
              <div className="space-y-4">
                {!loaded ? (
                  <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-100 rounded-2xl shadow-sm text-slate-400">
                    <Search size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                    <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อโหลดข้อมูลก่อน</p>
                  </div>
                ) : (
                  <>
                    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <h2 className="text-sm font-bold text-slate-800">ค้นหาตามรายการอาหาร / ไอเทม</h2>
                          <p className="text-xs text-slate-400 mt-0.5">พบ {filteredItemSummary.length.toLocaleString('th-TH')} รายการ | กดแถวใดเพื่อดูรายละเอียดแยกตามสาขา</p>
                        </div>
                        <div className="relative">
                          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                          <input
                            type="text"
                            placeholder="ค้นหาชื่อ / รหัสไอเทม..."
                            value={itemSearch}
                            onChange={e => { setItemSearch(e.target.value); setSelectedItem(null); }}
                            className="pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 w-full sm:w-64"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
                      <div className="overflow-auto max-h-[70vh] min-h-[480px]">
                        <table className="lock-table-dark w-full text-xs">
                          <thead className="bg-slate-900 text-white sticky top-0 z-10">
                            <tr>
                              {ITEM_COLUMNS.map(col => (
                                <th
                                  key={col.key}
                                  onClick={() => setItemSearchSort(s => ({ col: col.key, asc: s.col === col.key ? !s.asc : false }))}
                                  className="px-4 py-3 text-left font-semibold cursor-pointer hover:bg-slate-800 whitespace-nowrap select-none"
                                >
                                  <div className="flex items-center gap-1">
                                    {col.label}
                                    {itemSearchSort.col === col.key ? (itemSearchSort.asc ? ' ▲' : ' ▼') : <span className="opacity-30"> ▼</span>}
                                  </div>
                                </th>
                              ))}
                            </tr>
                            <tr className="bg-slate-800/80 border-t border-slate-700">
                              {ITEM_COLUMNS.map(col => (
                                <th key={col.key} className="px-2 py-1.5 font-normal">
                                  <ExcelFilterDropdown
                                    columnKey={col.key}
                                    label={col.label}
                                    value={itemColF[col.key] || []}
                                    onChange={val => setItemColF(prev => ({ ...prev, [col.key]: val }))}
                                    dataset={itemSummaryData}
                                    getValFn={getItemColFilterValue}
                                  />
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {filteredItemSummary.map((item, i) => (
                              <tr
                                key={item.itemCode}
                                onClick={() => setSelectedItem(selectedItem?.itemCode === item.itemCode ? null : item)}
                                className={`cursor-pointer transition-colors hover:bg-amber-50 ${selectedItem?.itemCode === item.itemCode ? 'bg-amber-100 font-semibold' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}
                              >
                                <td className="px-4 py-2.5 font-mono text-slate-500">{item.itemCode}</td>
                                <td className="px-4 py-2.5 text-slate-800 font-medium max-w-[220px] truncate">{item.nameThai}</td>
                                <td className="px-4 py-2.5 text-slate-400 max-w-[160px] truncate">{item.nameEng}</td>
                                <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(item.totalQty)}</td>
                                <td className="px-4 py-2.5 text-right font-mono text-amber-600">{fmtMoney(item.totalGross)}</td>
                                <td className="px-4 py-2.5 text-right font-mono text-rose-600">{fmtMoney(item.totalCost)}</td>
                                <td className={`px-4 py-2.5 text-right font-mono font-bold ${item.profit >= 0 ? 'text-emerald-600' : 'text-rose-700'}`}>{item.profit >= 0 ? '+' : ''}{fmtMoney(item.profit)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="bg-amber-50/60 border-t-2 border-amber-500 font-bold text-slate-800">
                              <td className="px-4 py-3" colSpan={3}>รวมทั้งหมด</td>
                              <td className="px-4 py-3 text-right font-mono">{fmtNum(filteredItemSummary.reduce((s, r) => s + r.totalQty, 0))}</td>
                              <td className="px-4 py-3 text-right font-mono text-amber-700">{fmtMoney(filteredItemSummary.reduce((s, r) => s + r.totalGross, 0))}</td>
                              <td className="px-4 py-3 text-right font-mono text-rose-700">{fmtMoney(filteredItemSummary.reduce((s, r) => s + r.totalCost, 0))}</td>
                              <td className="px-4 py-3 text-right font-mono text-emerald-700">{fmtMoney(filteredItemSummary.reduce((s, r) => s + r.profit, 0))}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>


                  </>
                )}
              </div>
            )}
          </>
        )}


          </div>
        </main>
      </div>

      {/* BILL DETAILS MODAL */}
      {excludedModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setExcludedModalOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Layers size={18} className="text-slate-400" />
                  <span>รายการที่ไม่นำมาคำนวณ (โต๊ะ 600 + ไอเทมเตรียม)</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  {selectedOutlet ? `สาขา ${outletLabel(selectedOutlet)}` : 'ทุกสาขา'} • {excludedStats.lines.toLocaleString('th-TH')} รายการ • {fmtNum(excludedStats.totalQty)} ชิ้น
                </p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setExcludedModalOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {excludedBreakdown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                  <p className="text-sm">ไม่มีรายการที่ถูกตัดออกในช่วงที่เลือก</p>
                </div>
              ) : (
                <div className="overflow-auto max-h-[55vh] border border-slate-100 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 font-bold">
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">เหตุผล</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">รหัสไอเทม</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ชื่อรายการ</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">จำนวน</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุน/หน่วย</th>
                        <th className="px-4 py-3 text-rose-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุนรวม</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {excludedBreakdown.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">{c.reason}</td>
                          <td className="px-4 py-2.5 font-mono text-slate-500">{c.itemCode}</td>
                          <td className="px-4 py-2.5 font-semibold text-slate-800">{c.name}</td>
                          <td className="px-4 py-2.5 text-right font-mono">{fmtNum(c.qty)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmtMoney(c.unitCost)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-rose-600 font-bold">{fmtMoney(c.totalCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-100 border-t-2 border-slate-400 font-bold text-slate-800 sticky bottom-0">
                        <td className="px-4 py-3" colSpan={3}>รวมทั้งหมด</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(excludedStats.totalQty)}</td>
                        <td />
                        <td className="px-4 py-3 text-right font-mono text-rose-700">{fmtMoney(excludedStats.totalCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {dailyCostModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setDailyCostModal(m => ({ ...m, open: false }))}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Layers size={18} className={dailyCostModal.type === 'prep' ? 'text-orange-400' : 'text-rose-400'} />
                  <span>{dailyCostModal.type === 'prep' ? 'ต้นทุนโต๊ะเตรียม(กก)' : 'ต้นทุนรวม'}</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  {dailyCostModal.date} • {outletLabel(dailyCostModal.outletID)} • {dailyCostDetail.rows.length} รายการ
                </p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setDailyCostModal(m => ({ ...m, open: false }))}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {dailyCostDetail.rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                  <p className="text-sm">ไม่มีรายการในวันนี้</p>
                </div>
              ) : (
                <div className="overflow-auto max-h-[55vh] border border-slate-100 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 font-bold">
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">รหัสไอเทม</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ชื่อรายการ</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">จำนวน</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุน/หน่วย</th>
                        <th className={`px-4 py-3 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200 ${dailyCostModal.type === 'prep' ? 'text-orange-600' : 'text-rose-600'}`}>ต้นทุนรวม</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {dailyCostDetail.rows.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 font-mono text-slate-500">{c.itemCode}</td>
                          <td className="px-4 py-2.5 font-semibold text-slate-800">{c.name}</td>
                          <td className="px-4 py-2.5 text-right font-mono">{fmtNum(c.qty)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmtMoney(c.unitCost)}</td>
                          <td className={`px-4 py-2.5 text-right font-mono font-bold ${dailyCostModal.type === 'prep' ? 'text-orange-600' : 'text-rose-600'}`}>{fmtMoney(c.totalCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className={`border-t-2 font-bold text-slate-800 sticky bottom-0 ${dailyCostModal.type === 'prep' ? 'bg-orange-50 border-orange-500' : 'bg-rose-50 border-rose-500'}`}>
                        <td className="px-4 py-3" colSpan={2}>รวมทั้งหมด</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(dailyCostDetail.totalQty)}</td>
                        <td />
                        <td className={`px-4 py-3 text-right font-mono ${dailyCostModal.type === 'prep' ? 'text-orange-700' : 'text-rose-700'}`}>{fmtMoney(dailyCostDetail.totalCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {prepModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setPrepModalOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Layers size={18} className="text-orange-400" />
                  <span>ต้นทุนโต๊ะเตรียม(กก)</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  {selectedOutlet ? `สาขา ${outletLabel(selectedOutlet)}` : 'ทุกสาขา'} • {prepStats.lines.toLocaleString('th-TH')} รายการ • {fmtNum(prepStats.totalQty)} กก.
                </p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setPrepModalOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {prepBreakdown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                  <p className="text-sm">ไม่มีรายการวัตถุดิบโต๊ะเตรียม(กก) ในช่วงที่เลือก</p>
                </div>
              ) : (
                <div className="overflow-auto max-h-[55vh] border border-slate-100 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 font-bold">
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">รหัสไอเทม</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ชื่อรายการ</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">จำนวน (กก.)</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุน/หน่วย</th>
                        <th className="px-4 py-3 text-orange-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุนรวม</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {prepBreakdown.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 font-mono text-slate-500">{c.itemCode}</td>
                          <td className="px-4 py-2.5 font-semibold text-slate-800">{c.name}</td>
                          <td className="px-4 py-2.5 text-right font-mono">{fmtNum(c.qty)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmtMoney(c.unitCost)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-orange-600 font-bold">{fmtMoney(c.totalCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-orange-50 border-t-2 border-orange-500 font-bold text-slate-800 sticky bottom-0">
                        <td className="px-4 py-3" colSpan={2}>รวมทั้งหมด</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(prepStats.totalQty)}</td>
                        <td />
                        <td className="px-4 py-3 text-right font-mono text-orange-700">{fmtMoney(prepStats.totalCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {costModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setCostModalOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Layers size={18} className="text-rose-400" />
                  <span>รายละเอียดต้นทุน</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  {selectedOutlet ? `สาขา ${outletLabel(selectedOutlet)}` : 'ทุกสาขา'} • {costBreakdown.length.toLocaleString('th-TH')} รายการที่มีต้นทุน
                </p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setCostModalOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {costBreakdown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                  <p className="text-sm">ไม่มีข้อมูลต้นทุน</p>
                </div>
              ) : (
                <div className="overflow-auto max-h-[55vh] border border-slate-100 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 font-bold">
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">รหัสไอเทม</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ชื่อรายการ</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">จำนวน</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุน/หน่วย</th>
                        <th className="px-4 py-3 text-rose-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุนรวม</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {costBreakdown.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 font-mono text-slate-500">{c.itemCode}</td>
                          <td className="px-4 py-2.5 font-semibold text-slate-800">{c.name}</td>
                          <td className="px-4 py-2.5 text-right font-mono">{fmtNum(c.qty)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmtMoney(c.unitCost)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-rose-600 font-bold">{fmtMoney(c.totalCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-rose-50 border-t-2 border-rose-500 font-bold text-slate-800 sticky bottom-0">
                        <td className="px-4 py-3" colSpan={2}>ต้นทุนรวมทั้งหมด</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(costBreakdown.reduce((s, c) => s + c.qty, 0))}</td>
                        <td />
                        <td className="px-4 py-3 text-right font-mono text-rose-700">{fmtMoney(stats.sumCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setModal(m => ({ ...m, open: false }))}>
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <ShoppingBag size={18} className="text-amber-400" />
                  <span>รายละเอียดรายการในบิล</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">เลขที่บิล Check ID: <span className="font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded">{modal.checkID}</span></p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setModal(m => ({ ...m, open: false }))}>
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {modal.loading ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <div className="animate-spin rounded-full h-8 w-8 border-4 border-amber-500 border-t-transparent mb-4" />
                  <p className="text-sm">กำลังโหลดรายละเอียดบิล…</p>
                </div>
              ) : modal.error ? (
                <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-center gap-2">
                  <XCircle size={18} />
                  <span>{modal.error}</span>
                </div>
              ) : modal.rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <HelpCircle size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
                  <p className="text-sm">ไม่พบรายละเอียดรายการในบิลเลขที่นี้</p>
                </div>
              ) : (
                <div className="overflow-auto max-h-[50vh] border border-slate-100 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 font-bold">
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">รหัสรายการ</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ชื่อรายการอาหาร</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">จำนวน</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ราคาต่อหน่วย</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ราคาก่อน Vat</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ภาษี (Vat)</th>
                        <th className="px-4 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ราคารวม</th>
                        <th className="px-4 py-3 text-slate-600 text-right text-rose-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุนรวม</th>
                        <th className="px-4 py-3 text-slate-600 text-right text-rose-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">ต้นทุนต่อหน่วย</th>
                        <th className="px-4 py-3 text-slate-600 text-center sticky top-0 bg-slate-50 z-20 border-b border-slate-200">โต๊ะ</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">เวลาที่สั่ง</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">สถานะ</th>
                        <th className="px-4 py-3 text-slate-600 sticky top-0 bg-slate-50 z-20 border-b border-slate-200">เลขออเดอร์</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {modal.rows.map((r, i) => {
                        const isVoided = r.void;
                        const qty = parseFloat(r.quantity) || 0;
                        const unitCost = costMap[r.itemCode] ?? 0;
                        const totalCost = unitCost * qty;
                        const lineVat = parseFloat(r.tax || 0);
                        const lineGross = parseFloat(r.grossPrice || 0);
                        const lineTotal = lineGross + lineVat;
                        return (
                          <tr key={i} className={`hover:bg-slate-50/50 transition-colors ${isVoided ? 'row-void bg-rose-50/10' : ''}`}>
                            <td className="px-4 py-2.5 font-mono text-slate-500">{r.itemCode || '-'}</td>
                            <td className="px-4 py-2.5 font-semibold text-slate-800">{r.nameThai || '-'}</td>
                            <td className="px-4 py-2.5 text-right font-mono">{fmtNum(r.quantity)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmtMoney(r.unitPrice)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-emerald-600 font-semibold">{fmtMoney(lineGross)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmtMoney(lineVat)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-amber-600 font-bold">{fmtMoney(lineTotal)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-rose-600 font-semibold">{fmtMoney(totalCost)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-rose-500/80">{fmtMoney(unitCost)}</td>
                            <td className="px-4 py-2.5 text-center font-mono">{r.tableID || '-'}</td>
                            <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{r.prtOrdTime || '-'}</td>
                            <td className="px-4 py-2.5">
                              {isVoided ? (
                                <span className="flex items-center gap-1 text-rose-600 font-semibold">
                                  <XCircle size={12} />
                                  <span>ยกเลิก</span>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                                  <CheckCircle size={12} />
                                  <span>ปกติ</span>
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-slate-400">{r.orderID || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {(() => {
                        const totalQty = modal.rows.reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0);
                        const totalGross = modal.rows.reduce((s, r) => s + (parseFloat(r.grossPrice) || 0), 0);
                        const totalVat = modal.rows.reduce((s, r) => s + (parseFloat(r.tax) || 0), 0);
                        const totalCombined = totalGross + totalVat;
                        const totalCost = modal.rows.reduce((sum, r) => {
                          if (r.void) return sum;
                          const qty = parseFloat(r.quantity) || 0;
                          const unitCost = costMap[r.itemCode] ?? 0;
                          return sum + (unitCost * qty);
                        }, 0);
                        const profit = totalGross - totalCost;

                        return (
                          <>
                            {/* Total row */}
                            <tr className="bg-amber-50/50 border-t-2 border-amber-500 font-bold text-slate-800">
                              <td className="px-4 py-3" colSpan={2}>ยอดรวมทั้งหมด</td>
                              <td className="px-4 py-3 text-right font-mono">{fmtNum(totalQty)}</td>
                              <td />
                              <td className="px-4 py-3 text-right font-mono text-emerald-700">{fmtMoney(totalGross)}</td>
                              <td className="px-4 py-3 text-right font-mono text-slate-500">{fmtMoney(totalVat)}</td>
                              <td className="px-4 py-3 text-right font-mono text-amber-700">{fmtMoney(totalCombined)}</td>
                              <td className="px-4 py-3 text-right font-mono text-rose-700">{fmtMoney(totalCost)}</td>
                              <td />
                              <td colSpan={4} />
                            </tr>
                            {/* Profit row */}
                            <tr className="bg-emerald-50 border-t border-emerald-200 font-bold text-slate-800">
                              <td className="px-4 py-3 text-slate-700" colSpan={2}>กำไร / ขาดทุนสุทธิ (ของบิลนี้)</td>
                              <td colSpan={2} />
                              <td className="px-4 py-3 text-right font-mono text-emerald-700">{fmtMoney(totalGross)}</td>
                              <td />
                              <td />
                              <td className="px-4 py-3 text-right font-mono text-rose-700">{fmtMoney(totalCost)}</td>
                              <td className="px-4 py-3 text-right font-mono font-bold" colSpan={2}>
                                <span className={profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                                  {profit >= 0 ? '+' : ''}{fmtMoney(profit)}
                                </span>
                              </td>
                              <td colSpan={3} />
                            </tr>
                          </>
                        );
                      })()}
                    </tfoot>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex flex-col md:flex-row items-center justify-between gap-4 flex-shrink-0">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 text-xs w-full md:w-auto">
                <span className="text-slate-400 font-medium">พบทั้งหมด {!modal.loading && !modal.error ? modal.rows.length : 0} รายการอาหาร</span>
                {!modal.loading && !modal.error && modal.rows.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-white px-3.5 py-2 rounded-xl border border-slate-200/80 shadow-sm text-[11px]">
                    <span className="text-slate-500 font-bold">สรุปบิลนี้:</span>
                    <span className="text-emerald-600 font-bold">รายรับ: {fmtMoney(modal.rows.reduce((sum, r) => sum + (r.void ? 0 : parseFloat(r.grossPrice) || 0), 0))}</span>
                    <span className="text-slate-300">|</span>
                    <span className="text-rose-600 font-bold">ต้นทุน: {fmtMoney(modal.rows.reduce((sum, r) => {
                      if (r.void) return sum;
                      const qty = parseFloat(r.quantity) || 0;
                      const unitCost = costMap[r.itemCode] ?? 0;
                      return sum + (unitCost * qty);
                    }, 0))}</span>
                    <span className="text-slate-300">|</span>
                    {(() => {
                      const sales = modal.rows.reduce((sum, r) => sum + (r.void ? 0 : parseFloat(r.grossPrice) || 0), 0);
                      const cost = modal.rows.reduce((sum, r) => {
                        if (r.void) return sum;
                        const qty = parseFloat(r.quantity) || 0;
                        const unitCost = costMap[r.itemCode] ?? 0;
                        return sum + (unitCost * qty);
                      }, 0);
                      const profit = sales - cost;
                      return (
                        <span className={`font-bold ${profit >= 0 ? 'text-amber-600' : 'text-rose-600'}`}>
                          กำไร/ขาดทุน: {profit >= 0 ? '+' : ''}{fmtMoney(profit)}
                        </span>
                      );
                    })()}
                  </div>
                )}
              </div>
              <button 
                onClick={() => setModal(m => ({ ...m, open: false }))}
                className="bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all self-end md:self-auto"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ITEM BRANCH BREAKDOWN MODAL */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedItem(null)}>
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Building2 size={18} className="text-amber-400" />
                  <span>จำนวนการใช้งานแยกตามสาขา</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  รายการอาหาร: <span className="font-semibold text-white bg-slate-800 px-2 py-0.5 rounded mr-2">{selectedItem.nameThai}</span>
                  รหัสไอเทม: <span className="font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded">{selectedItem.itemCode}</span>
                </p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setSelectedItem(null)}>
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="overflow-auto border border-slate-100 rounded-xl">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-5 py-3 text-slate-600 sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">สาขา</th>
                      <th className="px-5 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">จำนวน (ชิ้น)</th>
                      <th className="px-5 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">มูลค่ารวม</th>
                      <th className="px-5 py-3 text-slate-600 text-right text-rose-600 sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">ต้นทุน</th>
                      <th className="px-5 py-3 text-slate-600 text-right sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">กำไร</th>
                      <th className="px-5 py-3 text-slate-600 sticky top-0 bg-slate-50 z-10 border-b border-slate-200 font-bold">สัดส่วน (%)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(() => {
                      const totalAllQty = itemBranchData.reduce((s, b) => s + b.totalQty, 0);
                      return itemBranchData.map((branch, i) => (
                        <tr key={branch.outletID} className={`hover:bg-slate-50/50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                          <td className="px-5 py-3 font-semibold text-slate-800">{branch.name}</td>
                          <td className="px-5 py-3 text-right font-mono font-bold text-amber-700">{fmtNum(branch.totalQty)}</td>
                          <td className="px-5 py-3 text-right font-mono text-slate-700">{fmtMoney(branch.totalGross)}</td>
                          <td className="px-5 py-3 text-right font-mono text-rose-600">{fmtMoney(branch.totalCost)}</td>
                          <td className={`px-5 py-3 text-right font-mono font-bold ${branch.profit >= 0 ? 'text-emerald-600' : 'text-rose-700'}`}>
                            {branch.profit >= 0 ? '+' : ''}{fmtMoney(branch.profit)}
                          </td>
                          <td className="px-5 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-2 min-w-[120px]">
                              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${(branch.totalQty / (itemBranchData[0]?.totalQty || 1)) * 100}%` }} />
                              </div>
                              <span className="text-slate-500 font-mono w-10 text-right">
                                {totalAllQty > 0 ? ((branch.totalQty / totalAllQty) * 100).toFixed(1) : '0.0'}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                  <tfoot>
                    <tr className="bg-amber-50/60 border-t-2 border-amber-500 font-bold text-slate-800">
                      <td className="px-5 py-3">รวมทั้งหมด</td>
                      <td className="px-5 py-3 text-right font-mono text-amber-700">{fmtNum(itemBranchData.reduce((s, b) => s + b.totalQty, 0))}</td>
                      <td className="px-5 py-3 text-right font-mono">{fmtMoney(itemBranchData.reduce((s, b) => s + b.totalGross, 0))}</td>
                      <td className="px-5 py-3 text-right font-mono text-rose-700">{fmtMoney(itemBranchData.reduce((s, b) => s + b.totalCost, 0))}</td>
                      <td className="px-5 py-3 text-right font-mono text-emerald-700">{fmtMoney(itemBranchData.reduce((s, b) => s + b.profit, 0))}</td>
                      <td className="px-5 py-3 text-slate-500 text-xs">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-slate-400 font-medium">ทั้งหมด {itemBranchData.length} สาขาที่มีการใช้งาน</span>
              <button 
                onClick={() => setSelectedItem(null)}
                className="bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DAILY BILLS LIST MODAL */}
      {showDailyBillsModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setShowDailyBillsModal(prev => ({ ...prev, open: false }))}>
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-scale-up" onClick={e => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <ShoppingBag size={18} className="text-amber-400" />
                  <span>รายการบิลแยกตามประเภท</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">{showDailyBillsModal.title}</p>
              </div>
              <button className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all" onClick={() => setShowDailyBillsModal(prev => ({ ...prev, open: false }))}>
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="overflow-auto border border-slate-100 rounded-xl">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-5 py-3 text-slate-600 font-bold w-20">ตัวช่วย</th>
                      <th className="px-5 py-3 text-slate-600 font-bold">เวลา</th>
                      <th className="px-5 py-3 text-slate-600 font-bold">Check ID</th>
                      <th className="px-5 py-3 text-slate-600 font-bold text-right">ยอดรวมบิล (Gross)</th>
                      <th className="px-5 py-3 text-slate-600 font-bold text-right text-rose-600">ต้นทุนรวม</th>
                      <th className="px-5 py-3 text-slate-600 font-bold">ประเภทชำระ</th>
                      <th className="px-5 py-3 text-slate-600 font-bold">เลขที่สมาชิก</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {showDailyBillsModal.bills.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-8 text-center text-slate-400">ไม่พบรายการบิล</td>
                      </tr>
                    ) : (
                      showDailyBillsModal.bills.map((row, i) => (
                        <tr key={i} className={`hover:bg-slate-50/50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                          <td className="px-5 py-2.5">
                            <button 
                              onClick={() => {
                                openDetail(row);
                              }}
                              className="flex items-center gap-1 px-2.5 py-1 border border-amber-200 hover:bg-amber-50 text-amber-700 font-semibold rounded-lg text-[10px] transition-colors"
                            >
                              <Eye size={12} />
                              <span>ดูบิล</span>
                            </button>
                          </td>
                          <td className="px-5 py-2.5 whitespace-nowrap">{row.startTime || row.postTime || '-'}</td>
                          <td className="px-5 py-2.5 font-mono whitespace-nowrap font-semibold text-slate-900">{row.checkID}</td>
                          <td className="px-5 py-2.5 text-right font-mono font-bold text-amber-700">{fmtMoney(row.billTotal)}</td>
                          <td className="px-5 py-2.5 text-right font-mono text-rose-600 font-bold">{fmtMoney(row.billCost)}</td>
                          <td className="px-5 py-2.5 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              String(row.paidType).toLowerCase().includes('cash') || String(row.paidType).includes('สด')
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}>
                              {row.paidType || '-'}
                            </span>
                          </td>
                          <td className="px-5 py-2.5 font-mono text-slate-600">{row.memberTel || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="bg-amber-50/60 border-t-2 border-amber-500 font-bold text-slate-800">
                      <td className="px-5 py-3" colSpan={3}>รวมทั้งหมด</td>
                      <td className="px-5 py-3 text-right font-mono text-amber-700">{fmtMoney(showDailyBillsModal.bills.reduce((s, b) => s + (parseFloat(b.billTotal) || 0), 0))}</td>
                      <td className="px-5 py-3 text-right font-mono text-rose-700">{fmtMoney(showDailyBillsModal.bills.reduce((s, b) => s + (parseFloat(b.billCost) || 0), 0))}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-slate-400 font-medium">ทั้งหมด {showDailyBillsModal.bills.length} บิล</span>
              <button 
                onClick={() => setShowDailyBillsModal(prev => ({ ...prev, open: false }))}
                className="bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
