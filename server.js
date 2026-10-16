const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Hãy cấu hình MONGO_URI trong Environment Variables của Render.
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Trang chủ: ưu tiên public/index.html, sau đó mới đến index.html ở thư mục dự án.
function sendFirstExisting(res, candidates) {
  const file = candidates.find(candidate =>
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );

  if (!file) {
    return res.status(404).send(
      'Chưa tìm thấy file giao diện. Hãy đặt index.html trong thư mục public/ hoặc thư mục dự án.'
    );
  }

  return res.sendFile(file);
}

app.get('/', (req, res) => sendFirstExisting(res, [
  path.join(PUBLIC_DIR, 'index.html'),
  path.join(__dirname, 'index.html')
]));

app.get('/index.html', (req, res) => sendFirstExisting(res, [
  path.join(PUBLIC_DIR, 'index.html'),
  path.join(__dirname, 'index.html')
]));

app.get('/admin.html', (req, res) => sendFirstExisting(res, [
  path.join(PUBLIC_DIR, 'admin.html'),
  path.join(__dirname, 'admin.html')
]));

app.get('/health', (req, res) =>
  res.json({ success: true, service: 'dieu-hanh-bus' })
);

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
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    );

    await AccessLogModel.deleteMany({
      createdAt: { $lt: thirtyDaysAgo }
    });
  } catch (e) {
    console.error('Lỗi dọn dẹp log cũ:', e);
  }
}

// Trích xuất ngày tháng hiệu lực từ tên tab.
// Ví dụ: "02 (1.5.24)" hoặc "02 (1.5.24 - 1.7.24)"
function parseTabDate(tabName) {
  if (!tabName) {
    return { sortKey: '00000000', dateObj: new Date(0) };
  }

  const matches = [
    ...String(tabName).matchAll(/(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4})/g)
  ];

  if (matches.length > 0) {
    // Lấy mốc ngày cuối cùng làm chuẩn so sánh.
    const m = matches[matches.length - 1];

    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);

    if (y < 100) y += 2000;

    const dateObj = new Date(y, mo - 1, d);
    const sortKey =
      `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;

    return { sortKey, dateObj };
  }

  return { sortKey: '00000000', dateObj: new Date(0) };
}

// Đồng bộ dữ liệu: chỉ quét số nốt từ biểu đồ mới nhất.
async function cleanAndSyncData(data) {
  if (!data) return data;

  if (!Array.isArray(data.xeList)) data.xeList = [];

  if (
    !data.tuyenList ||
    typeof data.tuyenList !== 'object' ||
    Array.isArray(data.tuyenList)
  ) {
    data.tuyenList = {};
  }

  if (!Array.isArray(data.xeMauList)) data.xeMauList = [];
  if (!Array.isArray(data.bieuDoList)) data.bieuDoList = [];
  if (!Array.isArray(data.taiKhoanList)) data.taiKhoanList = [];

  // Loại xe trùng biển kiểm soát.
  const uniqueXeMap = new Map();

  data.xeList.forEach(x => {
    if (x && x.bks) {
      const bks = x.bks.trim().toUpperCase();

      uniqueXeMap.set(bks, {
        ...x,
        bks,
        maTuyen: String(x.maTuyen || '').trim().toUpperCase()
      });
    }
  });

  data.xeList = Array.from(uniqueXeMap.values());

  // Đếm số xe khai thác thực tế trên từng tuyến.
  const realKhCounts = {};

  data.xeList.forEach(x => {
    const maT = String(x.maTuyen || '').trim().toUpperCase();

    if (maT) {
      realKhCounts[maT] = (realKhCounts[maT] || 0) + 1;
    }
  });

  // Gom biểu đồ theo mã tuyến.
  const tuyenChartsMap = {};

  data.bieuDoList.forEach(item => {
    const tuyenStr = String(item.tuyen || item.tenTab || '').trim();
    const matchMa = tuyenStr.match(/^([A-Za-z0-9]+)/);

    if (matchMa) {
      const ma = matchMa[1].toUpperCase();

      if (!tuyenChartsMap[ma]) tuyenChartsMap[ma] = [];

      tuyenChartsMap[ma].push({
        ...item,
        dateInfo: parseTabDate(item.tenTab || item.bieuDo || '')
      });
    }
  });

  // Chọn biểu đồ mới nhất của từng tuyến.
  const maxNotMap = {};

  for (const ma in tuyenChartsMap) {
    const charts = tuyenChartsMap[ma];

    charts.sort(
      (a, b) => a.dateInfo.dateObj - b.dateInfo.dateObj
    );

    const latestChart = charts[charts.length - 1];

    if (latestChart && Array.isArray(latestChart.rawData)) {
      let maxNot = 0;

      latestChart.rawData.forEach(row => {
        const val = parseInt(String(row[0] || '').trim(), 10);

        if (!isNaN(val) && val > maxNot) {
          maxNot = val;
        }
      });

      if (maxNot > 0) {
        maxNotMap[ma] = maxNot;
      }
    }
  }

  // Cập nhật số xe khai thác và số xe vận doanh.
  for (const k in data.tuyenList) {
    const tObj = data.tuyenList[k];
    const maT = String(tObj.maTuyen || k).toUpperCase();

    const realKh = realKhCounts[maT] || 0;

    tObj.soXeKh = realKh;
    tObj.soXe = realKh;

    const foundVd = maxNotMap[maT];

    if (foundVd && foundVd > 0) {
      tObj.soXeVd = foundVd;
    } else {
      tObj.soXeVd =
        tObj.soXeVd && tObj.soXeVd > 0
          ? tObj.soXeVd
          : (realKh || 0);
    }
  }

  return data;
}

// Kết nối MongoDB.
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(async () => {
      console.log('>>> Kết nối MongoDB Atlas thành công!');

      const doc = await BusModel.findOne({ key: 'main_data' });

      if (doc && doc.data) {
        if (
          !doc.data.taiKhoanList ||
          doc.data.taiKhoanList.length === 0
        ) {
          // Không tự tạo tài khoản với mật khẩu mặc định.
          doc.data.taiKhoanList = [];
        }

        if (
          doc.data.thongBaoChay ===
          'Chào mừng bạn đến với Hệ thống Điều hành Buýt Transerco!'
        ) {
          doc.data.thongBaoChay = '';
        }

        const cleanedData = await cleanAndSyncData(doc.data);

        await BusModel.findOneAndUpdate(
          { key: 'main_data' },
          { key: 'main_data', data: cleanedData },
          { upsert: true }
        );

        console.log('>>> Đã làm sạch và đồng bộ dữ liệu thành công!');
      }
    })
    .catch(err => console.error('>>> Lỗi kết nối MongoDB:', err));
} else {
  console.error(
    'THIẾU MONGO_URI: hãy cấu hình biến môi trường MONGO_URI trước khi chạy server.'
  );
}

async function getRawData() {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });

    if (doc && doc.data) {
      return await cleanAndSyncData(doc.data);
    }
  } catch (err) {
    console.error('Lỗi đọc DB:', err);
  }

  const localPath = path.join(__dirname, 'bus_full_data.json');

  if (fs.existsSync(localPath)) {
    const fileData = JSON.parse(
      fs.readFileSync(localPath, 'utf8')
    );

    return await cleanAndSyncData(fileData);
  }

  return {
    tuyenList: {},
    bieuDoList: [],
    xeList: [],
    xeMauList: [],
    taiKhoanList: [],
    thongBaoChay: ''
  };
}

async function saveRawDataFast(data) {
  await BusModel.findOneAndUpdate(
    { key: 'main_data' },
    { key: 'main_data', data },
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

    res.json({
      success: true,
      text: raw.thongBaoChay || ''
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.post('/api/admin/luu-thong-bao', async (req, res) => {
  try {
    const { text } = req.body;
    const raw = await getRawData();

    raw.thongBaoChay = text !== undefined ? text : '';

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: 'Cập nhật nội dung thông báo thành công!'
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
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
      ip
    });

    await cleanOldLogs();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/admin/danh-sach-log', async (req, res) => {
  try {
    const logs = await AccessLogModel
      .find()
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const raw = await getRawData();

    if (!raw.taiKhoanList || raw.taiKhoanList.length === 0) {
      raw.taiKhoanList = [
        {
          username: 'quan',
          password: '123',
          role: 'master',
          permissions: ['tuyen', 'xe', 'bieudo'],
          status: 'active'
        }
      ];

      await saveRawDataFast(raw);
    }

    const user = raw.taiKhoanList.find(
      u => u.username === username && u.password === password
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Tài khoản không tồn tại trên hệ thống'
      });
    }

    if (user.status === 'locked') {
      return res.status(403).json({
        success: false,
        message: 'Tài khoản của bạn đang bị tạm khóa!'
      });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    await AccessLogModel.create({
      username: user.username,
      role: user.role,
      action: 'Đăng nhập trang quản trị',
      ip
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

    res.json({
      success: true,
      data: (raw.taiKhoanList || []).map(({ password, ...account }) => account)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/dang-ky', async (req, res) => {
  try {
    const { username, password, role, permissions } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin tài khoản!'
      });
    }

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    if (raw.taiKhoanList.some(u => u.username === username)) {
      return res.status(400).json({
        success: false,
        message: 'Tên tài khoản đã tồn tại!'
      });
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

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tài khoản!'
      });
    }

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

    if (!username || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin mật khẩu mới!'
      });
    }

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === username);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tài khoản!'
      });
    }

    user.password = newPassword;

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: `Đã đổi mật khẩu cho tài khoản [${username}] thành công!`
    });
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

// ===== DANH MỤC XE MẪU =====
app.get('/api/admin/danh-sach-xe-mau', async (req, res) => {
  try {
    const raw = await getRawData();

    res.json({
      success: true,
      data: Array.isArray(raw.xeMauList) ? raw.xeMauList : []
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
      data: []
    });
  }
});

app.post('/api/admin/luu-xe-mau', async (req, res) => {
  try {
    const chungLoai = String(req.body.chungLoai || '').trim();
    const sucChua = String(req.body.sucChua || '').trim();

    if (!chungLoai) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập chủng loại xe!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];

    const existing = raw.xeMauList.find(
      x => String(x.chungLoai || '').trim().toLocaleLowerCase('vi') ===
        chungLoai.toLocaleLowerCase('vi')
    );

    if (existing) {
      existing.chungLoai = chungLoai;
      existing.sucChua = sucChua;
    } else {
      raw.xeMauList.push({ chungLoai, sucChua });
    }

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: existing ? 'Đã cập nhật mác xe mẫu!' : 'Đã thêm mác xe mẫu!'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-xe-mau', async (req, res) => {
  try {
    const chungLoai = String(req.body.chungLoai || '').trim();

    if (!chungLoai) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu chủng loại xe cần xóa!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];

    const before = raw.xeMauList.length;

    raw.xeMauList = raw.xeMauList.filter(
      x => String(x.chungLoai || '').trim().toLocaleLowerCase('vi') !==
        chungLoai.toLocaleLowerCase('vi')
    );

    if (raw.xeMauList.length === before) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy mác xe mẫu!'
      });
    }

    await saveRawDataFast(raw);

    res.json({ success: true, message: 'Đã xóa mác xe mẫu!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/import-xe-mau', async (req, res) => {
  try {
    const rawText = String(req.body.rawText || '').trim();

    if (!rawText) {
      return res.status(400).json({
        success: false,
        message: 'Chưa có dữ liệu để import!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeMauList)) raw.xeMauList = [];

    const byName = new Map(
      raw.xeMauList.map(x => [
        String(x.chungLoai || '').trim().toLocaleLowerCase('vi'),
        x
      ])
    );

    let imported = 0;

    for (const line of rawText.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;

      const parts = text.includes('\t')
        ? text.split('\t').map(x => x.trim())
        : text.split(/\s{2,}/).map(x => x.trim());

      const chungLoai = String(parts[0] || '').trim();
      const sucChua = String(parts[1] || '').trim();

      if (
        !chungLoai ||
        /^(chủng loại|chung loai|mác xe|mac xe)$/i.test(chungLoai)
      ) {
        continue;
      }

      const key = chungLoai.toLocaleLowerCase('vi');

      byName.set(key, {
        ...(byName.get(key) || {}),
        chungLoai,
        sucChua
      });

      imported++;
    }

    raw.xeMauList = Array.from(byName.values());

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: `Đã nhập/cập nhật ${imported} mác xe mẫu!`,
      data: raw.xeMauList
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Lưu đội xe theo tuyến.
// Giữ nguyên xe thuộc tuyến khác, đồng bộ xe của tuyến đang sửa.
app.post('/api/admin/luu-doi-xe-tuyen', async (req, res) => {
  try {
    const maTuyen = String(req.body.maTuyen || '').trim().toUpperCase();

    const danhSachXe = Array.isArray(req.body.danhSachXe)
      ? req.body.danhSachXe
      : null;

    if (!maTuyen || !danhSachXe) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã tuyến hoặc danh sách xe không hợp lệ!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const route =
      raw.tuyenList?.[maTuyen] ||
      Object.values(raw.tuyenList || {}).find(
        t => String(t.maTuyen || '').trim().toUpperCase() === maTuyen
      );

    const validCars = danhSachXe
      .filter(x => x && String(x.bks || '').trim())
      .map(x => ({
        ...x,
        bks: String(x.bks).trim().toUpperCase(),
        maTuyen,
        xn: x.xn || route?.xn || '',
        tenTuyen: x.tenTuyen || route?.tenTuyen || ''
      }));

    const submittedPlates = new Set(validCars.map(x => x.bks));

    raw.xeList = raw.xeList.filter(x => {
      const sameRoute =
        String(x.maTuyen || '').trim().toUpperCase() === maTuyen;

      const plate = String(x.bks || '').trim().toUpperCase();

      return !(sameRoute && !submittedPlates.has(plate));
    });

    const existingByPlate = new Map(
      raw.xeList.map((x, i) => [
        String(x.bks || '').trim().toUpperCase(),
        i
      ])
    );

    for (const car of validCars) {
      const idx = existingByPlate.get(car.bks);

      if (idx !== undefined) {
        raw.xeList[idx] = { ...raw.xeList[idx], ...car };
      } else {
        raw.xeList.push(car);
        existingByPlate.set(car.bks, raw.xeList.length - 1);
      }
    }

    await saveRawData(raw);

    res.json({
      success: true,
      message: `Đã đồng bộ ${validCars.length} xe cho tuyến ${maTuyen}!`,
      count: validCars.length
    });
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
      for (const k in raw.tuyenList) {
        const item = raw.tuyenList[k];

        if (isAdmin || item.status !== 'locked') {
          activeRouteNames.add(item.tenTuyen || k);

          allRoutesList.push({
            maTuyen: item.maTuyen || k,
            tenTuyen: item.tenTuyen || k,
            xn: item.xn || '',
            dauA: item.dauA || '',
            dauB: item.dauB || '',
            soXeVd: item.soXeVd || 0,
            soXeKh: item.soXeKh || item.soXe || 0,
            loaiXe: item.loaiXe || '',
            sucChua: item.sucChua || '',
            status: item.status || 'active'
          });
        }
      }
    }

    if (Array.isArray(raw.bieuDoList)) {
      danhMucList = raw.bieuDoList
        .filter(item => isAdmin || activeRouteNames.has(item.tuyen))
        .map(item => ({
          xn: item.xn || '',
          tuyen: item.tuyen || '',
          bieuDo: item.bieuDo || '',
          tenTab: item.tenTab || ''
        }));
    }

    res.json({
      success: true,
      data: danhMucList,
      allRoutes: allRoutesList,
      bieuDoList: raw.bieuDoList || []
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/table-data', async (req, res) => {
  try {
    const { tab, tuyen } = req.query;
    const raw = await getRawData();

    const foundItem = (raw.bieuDoList || []).find(
      b => String(b.tenTab || '').trim() === String(tab || '').trim()
    );

    if (!foundItem) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy biểu đồ'
      });
    }

    let dauA = '';
    let dauB = '';

    for (const k in raw.tuyenList) {
      if (
        raw.tuyenList[k].tenTuyen === foundItem.tuyen ||
        raw.tuyenList[k].maTuyen === tuyen
      ) {
        dauA = raw.tuyenList[k].dauA || '';
        dauB = raw.tuyenList[k].dauB || '';
        break;
      }
    }

    res.json({
      success: true,
      rawData: foundItem.rawData || [],
      dauA,
      dauB
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/bus-data', async (req, res) => {
  try {
    const data = await getRawData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/bus-data', '/api/save-data'], async (req, res) => {
  try {
    await saveRawData(req.body);
    res.json({ success: true, message: 'Lưu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/save-tuyen', '/api/tuyen-moi'], async (req, res) => {
  try {
    const {
      maTuyen,
      tenTuyen,
      xn,
      dauA,
      dauB,
      soXeVd,
      soXeKh,
      loaiXe,
      sucChua,
      status
    } = req.body;

    if (!maTuyen) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã tuyến!'
      });
    }

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    raw.tuyenList[maTuyen] = {
      maTuyen,
      tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      xn: xn || '',
      dauA: dauA || '',
      dauB: dauB || '',
      soXeVd:
        parseInt(soXeVd, 10) ||
        raw.tuyenList[maTuyen]?.soXeVd ||
        0,
      soXeKh: parseInt(soXeKh, 10) || 0,
      soXe: parseInt(soXeKh, 10) || 0,
      loaiXe: loaiXe || '',
      sucChua: sucChua || '',
      status: status || 'active'
    };

    await saveRawDataFast(raw);

    res.json({ success: true, message: 'Lưu tuyến thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/toggle-status-tuyen', async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData();

    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy mã tuyến!'
      });
    }

    raw.tuyenList[maTuyen].status = status;

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: 'Cập nhật trạng thái thành công!'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/luu-bieu-do', async (req, res) => {
  try {
    const { xn, tuyen, bieuDo, tenTab, rawData } = req.body;

    if (!tenTab || !rawData) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu dữ liệu!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    const newTabObj = {
      xn: xn || '',
      tuyen: tuyen || '',
      bieuDo: bieuDo || '',
      tenTab,
      rawData
    };

    const idx = raw.bieuDoList.findIndex(
      b => String(b.tenTab || '').trim() === String(tenTab).trim()
    );

    if (idx >= 0) {
      raw.bieuDoList[idx] = newTabObj;
    } else {
      raw.bieuDoList.push(newTabObj);
    }

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message: 'Lưu biểu đồ thành công!'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/xoa-bieu-do', async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData();

    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];

    raw.bieuDoList = raw.bieuDoList.filter(
      b => String(b.tenTab || '').trim() !== String(tenTab).trim()
    );

    await saveRawDataFast(raw);

    res.json({ success: true, message: 'Đã xóa biểu đồ!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/tim-kiem-xe', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const tuyenQuery = (req.query.tuyen || '').trim().toUpperCase();
    const raw = await getRawData();

    let xeList = Array.isArray(raw.xeList) ? raw.xeList : [];

    let ketQua = q
      ? xeList.filter(x => (x.bks || '').toLowerCase().includes(q))
      : xeList;

    if (tuyenQuery) {
      const chuanHoaTuyen = str =>
        String(str || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

      const tuyenQueryNorm = chuanHoaTuyen(tuyenQuery);

      ketQua = ketQua.filter(
        x => chuanHoaTuyen(x.maTuyen) === tuyenQueryNorm
      );
    }

    const tuyenMap = raw.tuyenList || {};

    ketQua = ketQua.map(x => {
      const maXe = (x.maTuyen || '').toUpperCase();

      const foundTuyen =
        tuyenMap[maXe] ||
        Object.values(tuyenMap).find(
          t => (t.maTuyen || '').toUpperCase() === maXe
        );

      return {
        ...x,
        tenTuyen: foundTuyen
          ? foundTuyen.tenTuyen
          : `Tuyến ${x.maTuyen}`,
        xn: foundTuyen ? foundTuyen.xn : (x.donVi || ''),
        soXeVd: foundTuyen ? (foundTuyen.soXeVd || 0) : 0,
        soXeKh: foundTuyen
          ? (foundTuyen.soXeKh || foundTuyen.soXe || 0)
          : 0
      };
    });

    res.json({ success: true, data: ketQua });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  ['/api/import-xe-excel', '/api/import-danh-sach-xe'],
  async (req, res) => {
    try {
      const { rawText } = req.body;

      if (!rawText) {
        return res.status(400).json({
          success: false,
          message: 'Thiếu dữ liệu!'
        });
      }

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

        const matchTuyen = lineStr.match(
          /^(?:Tuyến\s+)?([0-9A-Za-z]+)\s*[:\-]\s*(.*)/i
        );

        if (matchTuyen) {
          currentMaTuyen = matchTuyen[1].toUpperCase();
          currentTenLoTrinh = matchTuyen[2]
            ? matchTuyen[2].trim()
            : '';
          break;
        }
      }

      if (!currentMaTuyen) {
        return res.status(400).json({
          success: false,
          message:
            'Không tìm thấy thông tin tuyến ở dòng tiêu đề! Vui lòng đặt dòng đầu có dạng: [MãTuyến]: [Tên Lộ Trình]'
        });
      }

      lines.forEach(line => {
        const fullLine = line.trim();
        if (!fullLine) return;

        const parts = fullLine.split(/[\t]+/).length > 1
          ? fullLine.split(/[\t]+/).map(p => p.trim())
          : fullLine.split(/\s{2,}/).map(p => p.trim());

        const bks = parts[0] || '';

        const isBks =
          /^[0-9]{2}[A-Z]{1,2}[-\.]?[0-9]{3,4}[\.0-9]*$/.test(bks) ||
          (bks.includes('-') && /\d/.test(bks) && bks.length <= 12);

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
          let dauA = '';
          let dauB = '';

          const loTrinhParts = currentTenLoTrinh.split('-');

          if (loTrinhParts.length >= 2) {
            dauA = loTrinhParts[0].trim();
            dauB = loTrinhParts[1].trim();
          }

          raw.tuyenList[currentMaTuyen] = {
            maTuyen: currentMaTuyen,
            tenTuyen:
              `${currentMaTuyen}. ${currentTenLoTrinh || 'Tuyến ' + currentMaTuyen}`,
            xn: 'Transerco',
            dauA,
            dauB,
            soXeVd: 0,
            soXeKh: importedCars.length,
            soXe: importedCars.length,
            loaiXe: importedCars[0]?.chungLoai || '',
            sucChua: importedCars[0]?.sucChua
              ? importedCars[0].sucChua + ' chỗ'
              : '',
            status: 'active'
          };
        }

        const existingMap = new Map();

        raw.xeList.forEach(x => {
          existingMap.set(x.bks.toUpperCase(), x);
        });

        importedCars.forEach(x => {
          existingMap.set(x.bks, x);
        });

        raw.xeList = Array.from(existingMap.values());
      }

      await saveRawData(raw);

      res.json({
        success: true,
        message:
          `Bóc tách và nạp thành công ${importedCars.length} xe vào tuyến ${currentMaTuyen}!`
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.post('/api/xoa-xe', async (req, res) => {
  try {
    const { bks } = req.body;

    if (!bks) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu biển kiểm soát xe cần xóa!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const initialLen = raw.xeList.length;

    raw.xeList = raw.xeList.filter(
      x => String(x.bks || '').trim().toUpperCase() !==
        String(bks).trim().toUpperCase()
    );

    if (raw.xeList.length === initialLen) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy biển số xe cần xóa!'
      });
    }

    await saveRawData(raw);

    res.json({
      success: true,
      message: `Đã xóa thành công xe [${bks}] khỏi hệ thống!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/dieu-chuyen-xe', async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;

    if (!bks || !tuyenMoi) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin điều chuyển!'
      });
    }

    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];

    const xe = raw.xeList.find(
      x => String(x.bks || '').trim().toUpperCase() ===
        String(bks).trim().toUpperCase()
    );

    if (!xe) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy biển kiểm soát xe!'
      });
    }

    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();

    await saveRawDataFast(raw);

    res.json({
      success: true,
      message:
        `Đã điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}] thành công!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/dieu-chuyen-xe-hang-loat', async (req, res) => {
  try {
    const { bksList, tuyenMoi } = req.body;

    if (
      !bksList ||
      !Array.isArray(bksList) ||
      bksList.length === 0 ||
      !tuyenMoi
    ) {
      return res.status(400).json({
        success: false,
        message: 'Dữ liệu không hợp lệ!'
      });
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

    res.json({
      success: true,
      message:
        `Đã điều chuyển thành công ${count} xe sang tuyến [${tuyenMoi}]!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
