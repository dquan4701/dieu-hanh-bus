const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://dquan4701_db_user:Quanbus123456@cluster0.sur3koa.mongodb.net/dieuhanhbus?retryWrites=true&w=majority';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const busDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_data' },
  data: Object
});
const BusModel = mongoose.model('BusData', busDataSchema);

const accessLogSchema = new mongoose.Schema({
  username: { type: String, default: 'Khách tra cứu' },
  role: { type: String, default: 'visitor' },
  action: { type: String },
  ip: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const AccessLogModel = mongoose.model('AccessLog', accessLogSchema);

async function cleanOldLogs() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await AccessLogModel.deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
  } catch (e) {
    console.error("Lỗi dọn dẹp log cũ:", e);
  }
}

function parseTabDate(tabName) {
  if (!tabName) return { sortKey: "00000000", dateObj: new Date(0) };
  const matches = [...String(tabName).matchAll(/(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4})/g)];
  if (matches.length > 0) {
    let m = matches[matches.length - 1];
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const dateObj = new Date(y, mo - 1, d);
    const sortKey = `${y}${String(mo).padStart(2,'0')}${String(d).padStart(2,'0')}`;
    return { sortKey, dateObj };
  }
  return { sortKey: "00000000", dateObj: new Date(0) };
}

function cleanAndSyncData(data) {
  if (!data) return { tuyenList: {}, bieuDoList: [], xeList: [], xeMauList: [], taiKhoanList: [], thongBaoChay: "" };
  if (!Array.isArray(data.xeList)) data.xeList = [];
  if (!data.tuyenList) data.tuyenList = {};
  if (!Array.isArray(data.xeMauList)) data.xeMauList = [];
  if (!Array.isArray(data.bieuDoList)) data.bieuDoList = [];
  if (!Array.isArray(data.taiKhoanList)) {
    data.taiKhoanList = [
      { username: 'quan', password: '123', role: 'master', permissions: ['tuyen', 'xe', 'bieudo'], status: 'active' }
    ];
  }

  const uniqueXeMap = new Map();
  data.xeList.forEach(x => {
    if (x && x.bks) {
      uniqueXeMap.set(x.bks.trim().toUpperCase(), {
        ...x,
        bks: x.bks.trim().toUpperCase(),
        maTuyen: String(x.maTuyen || '').trim().toUpperCase()
      });
    }
  });
  data.xeList = Array.from(uniqueXeMap.values());

  const realKhCounts = {};
  data.xeList.forEach(x => {
    let maT = String(x.maTuyen || '').trim().toUpperCase();
    if (maT) {
      realKhCounts[maT] = (realKhCounts[maT] || 0) + 1;
    }
  });

  const tuyenChartsMap = {};
  data.bieuDoList.forEach(item => {
    let tuyenStr = String(item.tuyen || item.tenTab || "").trim();
    let matchMa = tuyenStr.match(/^([A-Za-z0-9]+)/);
    if (matchMa) {
      let ma = matchMa[1].toUpperCase();
      if (!tuyenChartsMap[ma]) tuyenChartsMap[ma] = [];
      tuyenChartsMap[ma].push({
        ...item,
        dateInfo: parseTabDate(item.tenTab || item.bieuDo || "")
      });
    }
  });

  const maxNotMap = {};
  for (let ma in tuyenChartsMap) {
    const charts = tuyenChartsMap[ma];
    charts.sort((a, b) => a.dateInfo.dateObj - b.dateInfo.dateObj);
    const latestChart = charts[charts.length - 1];

    if (latestChart && Array.isArray(latestChart.rawData)) {
      let maxNot = 0;
      latestChart.rawData.forEach(row => {
        let val = parseInt(String(row[0] || '').trim(), 10);
        if (!isNaN(val) && val > maxNot) maxNot = val;
      });
      if (maxNot > 0) {
        maxNotMap[ma] = maxNot;
      }
    }
  }

  for (let k in data.tuyenList) {
    let tObj = data.tuyenList[k];
    let maT = (tObj.maTuyen || k).toUpperCase();

    let realKh = realKhCounts[maT] || 0;
    tObj.soXeKh = realKh; 
    tObj.soXe = realKh;

    let foundVd = maxNotMap[maT];
    if (foundVd && foundVd > 0) {
      tObj.soXeVd = foundVd;
    } else {
      tObj.soXeVd = tObj.soXeVd && tObj.soXeVd > 0 ? tObj.soXeVd : (realKh || 0);
    }
  }

  return data;
}

let cachedData = null;

async function getRawData() {
  if (cachedData) return cachedData;
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      cachedData = cleanAndSyncData(doc.data);
      return cachedData;
    }
  } catch (err) {
    console.error('Loi doc db:', err);
  }
  
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      cachedData = cleanAndSyncData(fileData);
      return cachedData;
    } catch (e) {}
  }
  
  cachedData = cleanAndSyncData({});
  return cachedData;
}

async function saveRawDataFast(data) {
  cachedData = cleanAndSyncData(data);
  try {
    await BusModel.findOneAndUpdate(
      { key: 'main_data' },
      { key: 'main_data', data: cachedData },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (e) {
    console.error("Lỗi lưu DB nhanh:", e);
  }
}

async function saveRawData(data) {
  await saveRawDataFast(data);
}

// Kết nối MongoDB an toàn
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(async () => {
    console.log('>>> Ket noi thanh cong MongoDB Atlas!');
    try {
      const doc = await BusModel.findOne({ key: 'main_data' });
      if (!doc || !doc.data) {
        const initial = cleanAndSyncData({});
        await BusModel.create({ key: 'main_data', data: initial });
      }
    } catch (e) {}
  })
  .catch(err => console.error('>>> Loi ket noi MongoDB (chạy chế độ dự phòng):', err.message));

// ==================== API QUẢN TRỊ MÁC XE MẪU ====================
app.get('/api/admin/danh-sach-xe-mau', async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, data: raw.xeMauList || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/luu-xe-mau', async (req, res) => {
  try {
    const { nhanHieu, chungLoai, sucChua } = req.body;
    if (!chungLoai) return res.status(400).json({ success: false, message: 'Thiếu chủng loại xe mẫu!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];

    const existing = raw.xeMauList.find(m => m.chungLoai.toLowerCase() === chungLoai.toLowerCase());
    if (existing) {
      existing.nhanHieu = nhanHieu || existing.nhanHieu;
      existing.sucChua = sucChua || existing.sucChua;
    } else {
      raw.xeMauList.push({ nhanHieu: nhanHieu ? nhanHieu.trim() : '', chungLoai: chungLoai.trim(), sucChua: sucChua || '' });
    }

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã lưu mác xe mẫu thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/xoa-xe-mau', async (req, res) => {
  try {
    const { chungLoai } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];
    raw.xeMauList = raw.xeMauList.filter(m => m.chungLoai !== chungLoai);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa mác xe mẫu thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/import-xe-mau', async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];

    const lines = rawText.split('\n');
    let count = 0;
    lines.forEach(l => {
      const parts = l.split(/[\t]+/).map(p => p.trim());
      if (parts.length >= 1 && parts[0]) {
        let nhanHieu = parts.length >= 2 ? parts[0] : '';
        let chungLoai = parts.length >= 2 ? parts[1] : parts[0];
        let sucChua = parts.length >= 3 ? parts[2] : (parts.length === 2 ? parts[1] : '');
        if (sucChua && !sucChua.toLowerCase().includes('chỗ')) sucChua += ' chỗ';
        
        const exist = raw.xeMauList.find(m => m.chungLoai.toLowerCase() === chungLoai.toLowerCase());
        if (exist) {
          exist.nhanHieu = nhanHieu || exist.nhanHieu;
          exist.sucChua = sucChua || exist.sucChua;
        } else {
          raw.xeMauList.push({ nhanHieu, chungLoai, sucChua });
          count++;
        }
      }
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: `Import thành công ${count} mác xe mẫu mới!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==================== API THÔNG BÁO & LOGS ====================
app.get('/api/thong-bao', async (req, res) => {
  try { const raw = await getRawData(); res.json({ success: true, text: raw.thongBaoChay || "" }); } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/luu-thong-bao', async (req, res) => {
  try {
    const { text } = req.body;
    const raw = await getRawData();
    raw.thongBaoChay = text !== undefined ? text : "";
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật nội dung thông báo thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/log-access', async (req, res) => {
  try {
    const { username, role, action } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    await AccessLogModel.create({ username: username || 'Khách tra cứu', role: role || 'visitor', action: action || 'Truy cập trang tra cứu', ip });
    await cleanOldLogs();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/danh-sach-log', async (req, res) => {
  try { const logs = await AccessLogModel.find().sort({ createdAt: -1 }).limit(200); res.json({ success: true, data: logs }); } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==================== API QUẢN TRỊ TÀI KHOẢN ====================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const raw = await getRawData();
    const user = raw.taiKhoanList.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Tài khoản không tồn tại trên hệ thống' });
    if (user.status === 'locked') return res.status(403).json({ success: false, message: 'Tài khoản của bạn đang bị tạm khóa!' });
    res.json({ success: true, role: user.role, permissions: user.permissions || [], message: 'Đăng nhập thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/danh-sach-tai-khoan', async (req, res) => {
  try { const raw = await getRawData(); res.json({ success: true, data: raw.taiKhoanList || [] }); } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/dang-ky', async (req, res) => {
  try {
    const { username, password, role, permissions } = req.body;
    const raw = await getRawData();
    if (raw.taiKhoanList.some(u => u.username === username)) return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    raw.taiKhoanList.push({ username, password, role: role || 'staff', permissions: permissions || [], status: 'active' });
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/sua-tai-khoan', async (req, res) => {
  try {
    const { username, status, role, permissions } = req.body;
    const raw = await getRawData();
    const user = raw.taiKhoanList.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    if (status) user.status = status;
    if (role) user.role = role;
    if (permissions) user.permissions = permissions;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/doi-mat-khau', async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    const raw = await getRawData();
    const user = raw.taiKhoanList.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    user.password = newPassword;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/xoa-tai-khoan', async (req, res) => {
  try {
    const { username } = req.body;
    const raw = await getRawData();
    raw.taiKhoanList = raw.taiKhoanList.filter(u => u.username !== username);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa tài khoản!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==================== API DANH MỤC, TUYẾN & XE ====================
app.get('/api/danh-muc', async (req, res) => {
  try {
    const isAdmin = req.query.admin === 'true';
    const raw = await getRawData();
    let danhMucList = [];
    let allRoutesList = [];
    const activeRouteNames = new Set();

    if (raw.tuyenList && typeof raw.tuyenList === 'object') {
      for (let k in raw.tuyenList) {
        const item = raw.tuyenList[k];
        if (isAdmin || item.status !== 'locked') {
          activeRouteNames.add(item.tenTuyen || k);
          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || k,
            xn: item.xn || "",
            dauA: item.dauA || "",
            dauB: item.dauB || "",
            soXeVd: item.soXeVd || 0,
            soXeKh: item.soXeKh || item.soXe || 0,
            loaiXe: item.loaiXe || "",
            sucChua: item.sucChua || "",
            status: item.status || "active"
          });
        }
      }
    }

    if (Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList
        .filter(item => isAdmin || activeRouteNames.has(item.tuyen))
        .map(item => ({ xn: item.xn || "", tuyen: item.tuyen || "", bieuDo: item.bieuDo || "", tenTab: item.tenTab || "" }));
    }

    res.json({ success: true, data: danhMucList, allRoutes: allRoutesList, bieuDoList: raw.bieuDoList || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/table-data', async (req, res) => {
  try {
    const { tab, tuyen } = req.query;
    const raw = await getRawData();
    const foundItem = (raw.bieuDoList || []).find(b => String(b.tenTab || '').trim() === String(tab || '').trim());
    if (!foundItem) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu đồ' });

    let dauA = "", dauB = "";
    for (let k in raw.tuyenList) {
      if (raw.tuyenList[k].tenTuyen === foundItem.tuyen || raw.tuyenList[k].maTuyen === tuyen) {
        dauA = raw.tuyenList[k].dauA || "";
        dauB = raw.tuyenList[k].dauB || "";
        break;
      }
    }
    res.json({ success: true, rawData: foundItem.rawData || [], dauA, dauB });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post(['/api/save-tuyen', '/api/tuyen-moi'], async (req, res) => {
  try {
    const { maTuyen, tenTuyen, xn, dauA, dauB, soXeVd, soXeKh, loaiXe, sucChua, status } = req.body;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    raw.tuyenList[maTuyen] = {
      maTuyen, tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      xn: xn || "", dauA: dauA || "", dauB: dauB || "",
      soXeVd: parseInt(soXeVd, 10) || raw.tuyenList[maTuyen]?.soXeVd || 0,
      soXeKh: parseInt(soXeKh, 10) || 0, soXe: parseInt(soXeKh, 10) || 0,
      loaiXe: loaiXe || "", sucChua: sucChua || "", status: status || "active"
    };

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu tuyến thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/luu-doi-xe-tuyen', async (req, res) => {
  try {
    const { maTuyen, danhSachXe } = req.body;
    if (!maTuyen || !Array.isArray(danhSachXe)) return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const normMa = String(maTuyen).trim().toUpperCase();
    raw.xeList = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() !== normMa);

    danhSachXe.forEach(x => {
      if (x.bks) {
        raw.xeList.push({
          bks: x.bks.trim().toUpperCase(),
          maTuyen: normMa,
          nhanHieu: x.nhanHieu || '',
          chungLoai: x.chungLoai || '',
          namSx: x.namSx || '',
          sucChua: x.sucChua || ''
        });
      }
    });

    await saveRawData(raw);
    res.json({ success: true, message: 'Lưu đội xe thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/toggle-status-tuyen', async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData();
    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) return res.status(404).json({ success: false, message: 'Không tìm thấy mã tuyến!' });
    raw.tuyenList[maTuyen].status = status;
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật trạng thái thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/luu-bieu-do', async (req, res) => {
  try {
    const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;
    if (!tenTab || !rawData) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];
    const newTabObj = { xn: xn || "", tuyen: tuyen || "", bieuDo: bieuDo || "", tenTab, rawData };
    const idx = raw.bieuDoList.findIndex(b => String(b.tenTab || '').trim() === String(tenTab).trim());
    if (idx >= 0) raw.bieuDoList[idx] = newTabObj;
    else raw.bieuDoList.push(newTabObj);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Lưu biểu đồ thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-bieu-do', async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];
    raw.bieuDoList = raw.bieuDoList.filter(b => String(b.tenTab || '').trim() !== String(tenTab).trim());
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa biểu đồ!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/tim-kiem-xe', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const raw = await getRawData();
    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];
    let ketQua = q ? xeList.filter(x => (x.bks || '').toLowerCase().includes(q)) : xeList;

    const tuyenMap = raw.tuyenList || {};
    ketQua = ketQua.map(x => {
      const maXe = (x.maTuyen || '').toUpperCase();
      let foundTuyen = tuyenMap[maXe] || Object.values(tuyenMap).find(t => (t.maTuyen || '').toUpperCase() === maXe);
      return {
        ...x,
        tenTuyen: foundTuyen ? foundTuyen.tenTuyen : `Tuyến ${x.maTuyen}`,
        xn: foundTuyen ? foundTuyen.xn : (x.donVi || ''),
        soXeVd: foundTuyen ? (foundTuyen.soXeVd || 0) : 0,
        soXeKh: foundTuyen ? (foundTuyen.soXeKh || foundTuyen.soXe || 0) : 0
      };
    });
    res.json({ success: true, data: ketQua });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe', async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    const raw = await getRawData();
    const xe = raw.xeList.find(x => String(x.bks || '').trim().toUpperCase() === String(bks).trim().toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: 'Không tìm thấy xe!' });
    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Điều chuyển xe thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
