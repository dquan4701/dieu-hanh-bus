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

// Hàm phân tích ngày tháng từ tên tab (VD: "01 (01.08.18 - Cả tuần)" -> tạo ra đối tượng thời gian chuẩn để so sánh)
function parseTabDate(tabName) {
  if (!tabName) return new Date(0);
  const match = String(tabName).match(/(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4})/);
  if (match) {
    let d = parseInt(match[1], 10);
    let m = parseInt(match[2], 10);
    let y = parseInt(match[3], 10);
    if (y < 100) y += 2000; // 18 -> 2018, 25 -> 2025...
    return new Date(y, m - 1, d);
  }
  return new Date(0); // Không có ngày thì coi như cũ nhất
}

// HÀM ĐỒNG BỘ THÔNG MINH: CHỈ LẤY SỐ NỐT TỪ BIỂU ĐỒ CÓ NGÀY THÁNG MỚI NHẤT CHO TỪNG TUYẾN
async function cleanAndSyncData(data) {
  if (!data) return data;
  if (!Array.isArray(data.xeList)) data.xeList = [];
  if (!data.tuyenList) data.tuyenList = {};

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

  // Gom nhóm các biểu đồ theo Mã tuyến, sau đó sắp xếp tìm ra biểu đồ có ngày mới nhất cho từng tuyến
  const tuyenChartsMap = {};
  if (Array.isArray(data.bieuDoList)) {
    data.bieuDoList.forEach(item => {
      let tuyenStr = String(item.tuyen || item.tenTab || "").trim();
      let matchMa = tuyenStr.match(/^([A-Za-z0-9]+)/);
      if (matchMa) {
        let ma = matchMa[1].toUpperCase();
        if (!tuyenChartsMap[ma]) tuyenChartsMap[ma] = [];
        tuyenChartsMap[ma].push({
          ...item,
          dateObj: parseTabDate(item.tenTab || item.bieuDo || "")
        });
      }
    });
  }

  // Với mỗi tuyến, chỉ lấy biểu đồ có dateObj mới nhất (gần hiện tại nhất) để tính số nốt vận doanh
  const maxNotMap = {};
  for (let ma in tuyenChartsMap) {
    const charts = tuyenChartsMap[ma];
    // Sắp xếp tăng dần theo thời gian, biểu đồ mới nhất sẽ nằm ở cuối mảng
    charts.sort((a, b) => a.dateObj - b.dateObj);
    const latestChart = charts[charts.length - 1]; // Lấy biểu đồ mới nhất

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
    // Gán số xe vận doanh theo số nốt của biểu đồ MỚI NHẤT
    if (foundVd && foundVd > 0) {
      tObj.soXeVd = foundVd;
    } else {
      tObj.soXeVd = tObj.soXeVd && tObj.soXeVd > 0 ? tObj.soXeVd : (realKh || 0);
    }
  }

  return data;
}

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('>>> Ket noi thanh cong MongoDB Atlas!');
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      if (!doc.data.taiKhoanList || doc.data.taiKhoanList.length === 0) {
        doc.data.taiKhoanList = [
          { username: 'quan', password: '123', role: 'master', permissions: ['tuyen', 'xe', 'bieudo'], status: 'active' }
        ];
      }
      if (doc.data.thongBaoChay === "Chào mừng bạn đến với Hệ thống Điều hành Buýt Transerco!") {
        doc.data.thongBaoChay = "";
      }
      const cleanedData = await cleanAndSyncData(doc.data);
      await BusModel.findOneAndUpdate({ key: 'main_data' }, { key: 'main_data', data: cleanedData }, { upsert: true });
      console.log('>>> Đã tự động làm sạch và đồng bộ dữ liệu thành công!');
    }
  })
  .catch(err => console.error('>>> Loi ket noi MongoDB:', err));

async function getRawData() {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      return await cleanAndSyncData(doc.data);
    }
  } catch (err) {
    console.error('Loi doc db:', err);
  }
  
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    return await cleanAndSyncData(fileData);
  }
  return { tuyenList: {}, bieuDoList: [], xeList: [], taiKhoanList: [], thongBaoChay: "" };
}

async function saveRawDataFast(data) {
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: data },
    { upsert: true, returnDocument: 'after' }
  );
}

async function saveRawData(data) {
  const cleaned = await cleanAndSyncData(data);
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data: cleaned },
    { upsert: true, returnDocument: 'after' }
  );
}

app.get('/api/thong-bao', async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, text: raw.thongBaoChay || "" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/luu-thong-bao', async (req, res) => {
  try {
    const { text } = req.body;
    const raw = await getRawData();
    raw.thongBaoChay = text !== undefined ? text : "";
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật nội dung thông báo thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/log-access', async (req, res) => {
  try {
    const { username, role, action } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    await AccessLogModel.create({
      username: username || 'Khách tra cứu',
      role: role || 'visitor',
      action: action || 'Truy cập trang tra cứu',
      ip: ip
    });

    await cleanOldLogs();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/danh-sach-log', async (req, res) => {
  try {
    const logs = await AccessLogModel.find().sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList || raw.taiKhoanList.length === 0) {
      raw.taiKhoanList = [
        { username: 'quan', password: '123', role: 'master', permissions: ['tuyen', 'xe', 'bieudo'], status: 'active' }
      ];
      await saveRawDataFast(raw);
    }

    const user = raw.taiKhoanList.find(u => u.username === username && u.password === password);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Tài khoản không tồn tại trên hệ thống' });
    }
    if (user.status === 'locked') {
      return res.status(403).json({ success: false, message: 'Tài khoản của bạn đang bị tạm khóa!' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    await AccessLogModel.create({
      username: user.username,
      role: user.role,
      action: 'Đăng nhập trang quản trị',
      ip: ip
    });

    res.json({ 
      success: true, 
      role: user.role, 
      permissions: user.permissions || [], 
      message: 'Đăng nhập thành công!' 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/danh-sach-tai-khoan', async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, data: raw.taiKhoanList || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/dang-ky', async (req, res) => {
  try {
    const { username, password, role, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin tài khoản!' });

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    if (raw.taiKhoanList.some(u => u.username === username)) {
      return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    raw.taiKhoanList.push({
      username,
      password,
      role: role || 'staff',
      permissions: permissions || [],
      status: 'active'
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/sua-tai-khoan', async (req, res) => {
  try {
    const { username, status, role, permissions } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

    if (status) user.status = status;
    if (role) user.role = role;
    if (permissions) user.permissions = permissions;

    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Cập nhật tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/doi-mat-khau', async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) return res.status(400).json({ success: false, message: 'Thiếu thông tin mật khẩu mới!' });

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

    user.password = newPassword;
    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã đổi mật khẩu cho tài khoản [${username}] thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-tai-khoan', async (req, res) => {
  try {
    const { username } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    raw.taiKhoanList = raw.taiKhoanList.filter(u => u.username !== username);
    await saveRawDataFast(raw);
    res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
        .map(item => ({
          xn: item.xn || "",
          tuyen: item.tuyen || "",
          bieuDo: item.bieuDo || "",
          tenTab: item.tenTab || ""
        }));
    }

    res.json({ success: true, data: danhMucList, allRoutes: allRoutesList, bieuDoList: raw.bieuDoList || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/bus-data', async (req, res) => {
  try { const data = await getRawData(); res.json(data); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post(['/api/bus-data', '/api/save-data'], async (req, res) => {
  try { await saveRawData(req.body); res.json({ success: true, message: 'Lưu thành công!' }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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
    const newTabObj = { xn: xn || "", tuyen: tuyen || "", bieuDo: bieuDo || "Cả tuần", tenTab, rawData };
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
    const tuyenQuery = (req.query.tuyen || '').trim().toUpperCase();
    const raw = await getRawData();
    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];
    
    let ketQua = q ? xeList.filter(x => (x.bks || '').toLowerCase().includes(q)) : xeList;
    
    if (tuyenQuery) {
      const chuanHoaTuyen = str => String(str || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      const tuyenQueryNorm = chuanHoaTuyen(tuyenQuery);
      ketQua = ketQua.filter(x => chuanHoaTuyen(x.maTuyen) === tuyenQueryNorm);
    }

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

app.post(['/api/import-xe-excel', '/api/import-danh-sach-xe'], async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    
    const lines = rawText.split('\n');
    let currentMaTuyen = '';
    let currentTenLoTrinh = '';
    const importedCars = [];

    for (let i = 0; i < lines.length; i++) {
      const lineStr = lines[i].trim();
      if (!lineStr) continue;
      const matchTuyen = lineStr.match(/^(?:Tuyến\s+)?([0-9A-Za-z]+)\s*[:\-]\s*(.*)/i);
      if (matchTuyen) {
        currentMaTuyen = matchTuyen[1].toUpperCase();
        currentTenLoTrinh = matchTuyen[2] ? matchTuyen[2].trim() : '';
        break;
      }
    }

    if (!currentMaTuyen) {
      return res.status(400).json({ 
        success: false, 
        message: 'Không tìm thấy thông tin tuyến ở dòng tiêu đề! Vui lòng đặt dòng đầu có dạng: [MãTuyến]: [Tên Lộ Trình]' 
      });
    }

    lines.forEach(line => {
      const fullLine = line.trim();
      if (!fullLine) return;

      const parts = fullLine.split(/[\t]+/).length > 1 
        ? fullLine.split(/[\t]+/).map(p => p.trim()) 
        : fullLine.split(/\s{2,}/).map(p => p.trim());
      
      const bks = parts[0] || '';
      const isBks = /^[0-9]{2}[A-Z]{1,2}[-\.]?[0-9]{3,4}[\.0-9]*$/.test(bks) || (bks.includes('-') && /\d/.test(bks) && bks.length <= 12);
      const isHeaderLine = /^[0-9A-Za-z]+\s*[:\-]\s*/.test(fullLine);

      if (isBks && !isHeaderLine) {
        importedCars.push({
          bks: bks.toUpperCase(), 
          maTuyen: currentMaTuyen, 
          nhanHieu: parts[1] || '',
          chungLoai: parts[2] || '', 
          namSx: parts[3] || '', 
          sucChua: parts[4] || '', 
          donVi: parts[5] || ''
        });
      }
    });

    if (importedCars.length > 0) {
      if (!raw.tuyenList[currentMaTuyen]) {
        let dauA = "", dauB = "";
        const loTrinhParts = currentTenLoTrinh.split('-');
        if (loTrinhParts.length >= 2) { dauA = loTrinhParts[0].trim(); dauB = loTrinhParts[1].trim(); }
        
        raw.tuyenList[currentMaTuyen] = {
          maTuyen: currentMaTuyen, 
          tenTuyen: `${currentMaTuyen}. ${currentTenLoTrinh || 'Tuyến ' + currentMaTuyen}`,
          xn: "Transerco", dauA, dauB, 
          soXeVd: 0, soXeKh: importedCars.length, soXe: importedCars.length, 
          loaiXe: importedCars[0]?.chungLoai || "", 
          sucChua: importedCars[0]?.sucChua ? importedCars[0].sucChua + " chỗ" : "", 
          status: "active"
        };
      }

      const existingMap = new Map();
      raw.xeList.forEach(x => existingMap.set(x.bks.toUpperCase(), x));
      importedCars.forEach(x => existingMap.set(x.bks, x));
      raw.xeList = Array.from(existingMap.values());
    }
    
    await saveRawData(raw);
    res.json({ success: true, message: `Bóc tách và nạp thành công ${importedCars.length} xe vào tuyến ${currentMaTuyen}!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-xe', async (req, res) => {
  try {
    const { bks } = req.body;
    if (!bks) return res.status(400).json({ success: false, message: 'Thiếu biển kiểm soát xe cần xóa!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    
    const initialLen = raw.xeList.length;
    raw.xeList = raw.xeList.filter(x => String(x.bks || '').trim().toUpperCase() !== String(bks).trim().toUpperCase());
    
    if (raw.xeList.length === initialLen) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy biển số xe cần xóa!' });
    }

    await saveRawData(raw);
    res.json({ success: true, message: `Đã xóa thành công xe [${bks}] khỏi hệ thống!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe', async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    if (!bks || !tuyenMoi) return res.status(400).json({ success: false, message: 'Thiếu thông tin điều chuyển!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    const xe = raw.xeList.find(x => String(x.bks || '').trim().toUpperCase() === String(bks).trim().toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: 'Không tìm thấy biển kiểm soát xe!' });
    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();
    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}] thành công!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe-hang-loat', async (req, res) => {
  try {
    const { bksList, tuyenMoi } = req.body;
    if (!bksList || !Array.isArray(bksList) || bksList.length === 0 || !tuyenMoi) {
      return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ!' });
    }
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const normTuyenMoi = String(tuyenMoi).trim().toUpperCase();
    let count = 0;
    raw.xeList.forEach(x => {
      if (bksList.includes(String(x.bks || '').trim().toUpperCase())) {
        x.maTuyen = normTuyenMoi;
        count++;
      }
    });

    await saveRawDataFast(raw);
    res.json({ success: true, message: `Đã điều chuyển thành công ${count} xe sang tuyến [${tuyenMoi}]!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
