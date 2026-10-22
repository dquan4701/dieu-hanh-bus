const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Khuyến nghị: Đưa chuỗi kết nối vào biến môi trường trên Render, tránh lộ mật khẩu trong code
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

// --- MIDDLEWARE BẢO MẬT & XÁC THỰC QUẢN TRỊ (Theo góp ý của bạn ông) ---
async function verifyAdmin(req, res, next) {
  try {
    // Lấy thông tin người thực hiện từ header hoặc body do client gửi lên
    const username = req.headers['x-admin-user'] || req.body.actorUsername;
    if (!username) {
      return res.status(401).json({ success: false, message: 'Chưa xác thực danh tính quản trị viên!' });
    }
    const raw = await getRawData();
    const user = (raw.taiKhoanList || []).find(u => u.username === username && u.status === 'active');
    if (!user) {
      return res.status(403).json({ success: false, message: 'Tài khoản không hợp lệ hoặc đã bị tạm khóa!' });
    }
    req.adminUser = user; // Gắn thông tin user đã được server kiểm chứng vào request
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi xác thực hệ thống: ' + err.message });
  }
}

// Hàm ghi log an toàn dựa trên thông tin đã xác thực từ Server
async function recordLog(req, actionDesc) {
  try {
    const user = req.adminUser;
    const username = user ? user.username : 'Hệ thống';
    const role = user ? user.role : 'staff';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    await AccessLogModel.create({ username, role, action: actionDesc, ip });
    await cleanOldLogs();
  } catch (e) {
    console.error("Lỗi ghi log:", e);
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

async function cleanAndSyncData(data) {
  if (!data) return data;
  if (!Array.isArray(data.xeList)) data.xeList = [];
  if (!data.tuyenList) data.tuyenList = {};
  if (!Array.isArray(data.danhMucXeMau)) data.danhMucXeMau = [];

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
  if (Array.isArray(data.bieuDoList)) {
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
  }

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

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('>>> Kết nối thành công MongoDB Atlas!');
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      if (!doc.data.taiKhoanList || doc.data.taiKhoanList.length === 0) {
        doc.data.taiKhoanList = [
          { username: 'quan', password: '123', role: 'master', permissions: ['tuyen', 'xe', 'bieudo'], status: 'active' }
        ];
      }
      const cleanedData = await cleanAndSyncData(doc.data);
      await BusModel.findOneAndUpdate({ key: 'main_data' }, { key: 'main_data', data: cleanedData }, { upsert: true });
      console.log('>>> Đã tự động làm sạch và đồng bộ dữ liệu thành công!');
    }
  })
  .catch(err => console.error('>>> Lỗi kết nối MongoDB:', err));

async function getRawData() {
  try {
    const doc = await BusModel.findOne({ key: 'main_data' });
    if (doc && doc.data) {
      return await cleanAndSyncData(doc.data);
    }
  } catch (err) {
    console.error('Lỗi đọc db:', err);
  }
  
  const localPath = path.join(__dirname, 'bus_full_data.json');
  if (fs.existsSync(localPath)) {
    const fileData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    return await cleanAndSyncData(fileData);
  }
  return { tuyenList: {}, bieuDoList: [], xeList: [], taiKhoanList: [], danhMucXeMau: [], thongBaoChay: "" };
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

// API Thông báo
app.get('/api/thong-bao', async (req, res) => {
  try {
    const raw = await getRawData();
    const defaultText = raw.thongBaoChay || "";
    const scheduleList = raw.thongBaoScheduleList || [];
    
    const now = new Date();
    const todayDate = now.toISOString().split('T')[0];
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    
    let textHienThi = defaultText;

    if (Array.isArray(scheduleList)) {
      for (let item of scheduleList) {
        const tuNgay = item.tuNgay;
        const denNgay = item.denNgay;
        const tuGio = item.tuGio || "00:00";
        const denGio = item.denGio || "23:59";

        const startStr = `${tuNgay} ${tuGio}`;
        const endStr = `${denNgay} ${denGio}`;
        const currentStr = `${todayDate} ${currentTime}`;

        if (currentStr >= startStr && currentStr <= endStr) {
          textHienThi = item.noiDung;
          break;
        }
      }
    }

    res.json({ success: true, text: textHienThi });
  } catch (err) {
    res.status(500).json({ success: false, text: "" });
  }
});

app.get('/api/thong-bao-chi-tiet', async (req, res) => {
  try {
    const raw = await getRawData();
    const now = new Date();
    
    let activeTexts = [];
    const scheduleList = raw.thongBaoScheduleList || [];

    // 1. Duyệt qua danh sách lịch để gom các thông báo đang có hiệu lực
    if (scheduleList.length > 0) {
      for (let item of scheduleList) {
        const start = new Date(`${item.tuNgay}T${item.tuGio || '00:00'}`);
        const end = new Date(`${item.denNgay}T${item.denGio || '23:59'}`);
        
        if (now >= start && now <= end) {
          if (item.noiDung && !activeTexts.includes(item.noiDung)) {
            activeTexts.push(item.noiDung.trim());
          }
        }
      }
    }

    // 2. Nối các thông báo đang hiệu lực bằng ký tự ' • ' hoặc dùng thông báo mặc định nếu không có lịch nào khớp
    let finalActiveText = "";
    if (activeTexts.length > 0) {
      finalActiveText = activeTexts.join("   •   ");
    } else {
      finalActiveText = raw.thongBaoChay || "Hệ thống điều hành xe buýt Hà Nội";
    }

    res.json({ 
      success: true, 
      defaultText: raw.thongBaoChay || "", 
      currentActiveText: finalActiveText, // Gửi chuỗi gộp ra ngoài marquee
      scheduleList: scheduleList 
    });
  } catch (err) {
    res.status(500).json({ success: false, defaultText: "", scheduleList: [] });
  }
});

// Các API quản trị được bảo vệ bởi middleware verifyAdmin
app.post('/api/admin/luu-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    const raw = await getRawData();
    raw.thongBaoChay = text !== undefined ? text : "";
    await saveRawDataFast(raw);
    await recordLog(req, 'Cập nhật thông báo mặc định');
    res.json({ success: true, message: 'Cập nhật thông báo mặc định thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/them-lich-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { tuNgay, tuGio, denNgay, denGio, noiDung } = req.body;
    if (!tuNgay || !denNgay || !noiDung) {
      return res.json({ success: false, message: "Thiếu thông tin ngày hoặc nội dung!" });
    }

    const raw = await getRawData();
    if (!raw.thongBaoScheduleList) raw.thongBaoScheduleList = [];

    raw.thongBaoScheduleList.push({
      id: Date.now().toString(),
      tuNgay,
      tuGio: tuGio || "00:00",
      denNgay,
      denGio: denGio || "23:59",
      noiDung
    });

    await saveRawDataFast(raw);
    await recordLog(req, 'Thêm lịch thông báo theo giờ');
    res.json({ success: true, message: "Đã thêm lịch thông báo thành công!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-lich-thong-bao', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    const raw = await getRawData();
    
    if (raw.thongBaoScheduleList) {
      raw.thongBaoScheduleList = raw.thongBaoScheduleList.filter(item => item.id !== id);
      await saveRawDataFast(raw);
    }
    await recordLog(req, 'Xóa lịch thông báo');
    res.json({ success: true, message: "Đã xóa mốc lịch thành công!" });
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

app.get('/api/admin/danh-sach-log', verifyAdmin, async (req, res) => {
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

app.get('/api/admin/danh-sach-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, data: raw.taiKhoanList || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/dang-ky', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, password, role, permissions } = req.body;
    if (!targetUsername || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin tài khoản mới!' });

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    if (raw.taiKhoanList.some(u => u.username === targetUsername)) {
      return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    raw.taiKhoanList.push({
      username: targetUsername,
      password,
      role: role || 'staff',
      permissions: permissions || [],
      status: 'active'
    });

    await saveRawDataFast(raw);
    await recordLog(req, `Tạo tài khoản quản trị mới [${targetUsername}]`);
    res.json({ success: true, message: 'Tạo tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/sua-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, status, role, permissions } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

    if (status) user.status = status;
    if (role) user.role = role;
    if (permissions) user.permissions = permissions;

    await saveRawDataFast(raw);
    await recordLog(req, `Cập nhật thông tin tài khoản [${targetUsername}]`);
    res.json({ success: true, message: 'Cập nhật tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/doi-mat-khau', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername, newPassword } = req.body;
    if (!targetUsername || !newPassword) return res.status(400).json({ success: false, message: 'Thiếu thông tin mật khẩu mới!' });

    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    const user = raw.taiKhoanList.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });

    user.password = newPassword;
    await saveRawDataFast(raw);
    await recordLog(req, `Đổi mật khẩu cho tài khoản [${targetUsername}]`);
    res.json({ success: true, message: `Đã đổi mật khẩu cho tài khoản [${targetUsername}] thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-tai-khoan', verifyAdmin, async (req, res) => {
  try {
    const { targetUsername } = req.body;
    const raw = await getRawData();
    if (!raw.taiKhoanList) raw.taiKhoanList = [];

    raw.taiKhoanList = raw.taiKhoanList.filter(u => u.username !== targetUsername);
    await saveRawDataFast(raw);
    await recordLog(req, `Xóa tài khoản [${targetUsername}]`);
    res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- QUẢN LÝ DANH MỤC MÁC XE MẪU (SỬA LỖI XÓA CHÍNH XÁC THEO CHỦNG LOẠI & NĂM SX) ---
app.get('/api/admin/danh-sach-xe-mau', async (req, res) => {
  try {
    const raw = await getRawData();
    res.json({ success: true, data: raw.danhMucXeMau || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/luu-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { chungLoai, sucChua, namSx } = req.body;
    if (!chungLoai) return res.status(400).json({ success: false, message: 'Thiếu chủng loại xe mẫu!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];
    
    const cleanNamSx = String(namSx || '').trim();
    const idx = raw.danhMucXeMau.findIndex(m => 
      m.chungLoai.toLowerCase() === chungLoai.toLowerCase() && 
      String(m.namSx || '').trim() === cleanNamSx
    );

    if (idx >= 0) {
      raw.danhMucXeMau[idx] = { chungLoai, sucChua, namSx: cleanNamSx };
    } else {
      raw.danhMucXeMau.push({ chungLoai, sucChua, namSx: cleanNamSx });
    }
    
    await saveRawDataFast(raw);
    await recordLog(req, `Lưu mác xe mẫu [${chungLoai} - Năm ${cleanNamSx || 'N/A'}]`);
    res.json({ success: true, message: 'Lưu mác xe mẫu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { chungLoai, namSx } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];
    const cleanNamSx = String(namSx || '').trim();
    
    raw.danhMucXeMau = raw.danhMucXeMau.filter(m => !(m.chungLoai === chungLoai && String(m.namSx || '').trim() === cleanNamSx));
    
    await saveRawDataFast(raw);
    await recordLog(req, `Xóa mác xe mẫu [${chungLoai} - Năm ${cleanNamSx || 'N/A'}]`);
    res.json({ success: true, message: 'Đã xóa mác xe mẫu thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/import-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ success: false, message: 'Thiếu dữ liệu!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];

    const lines = rawText.split('\n');
    let count = 0;
    lines.forEach(line => {
      const parts = line.split(/[\t]+/).length > 1 ? line.split(/[\t]+/).map(p => p.trim()) : line.split(/\s{2,}/).map(p => p.trim());
      const chungLoai = parts[0];
      const sucChua = parts[1] || '';
      const namSx = parts[2] || '';
      if (chungLoai) {
        const cleanNamSx = String(namSx || '').trim();
        const existing = raw.danhMucXeMau.find(m => m.chungLoai.toLowerCase() === chungLoai.toLowerCase() && String(m.namSx || '').trim() === cleanNamSx);
        if (!existing) {
          raw.danhMucXeMau.push({ 
            chungLoai, 
            sucChua: sucChua.toLowerCase().includes('chỗ') ? sucChua : (sucChua ? `${sucChua} chỗ` : ''),
            namSx: cleanNamSx 
          });
          count++;
        }
      }
    });

    await saveRawDataFast(raw);
    await recordLog(req, `Import ${count} mác xe mẫu từ Excel`);
    res.json({ success: true, message: `Import thành công ${count} mác xe mẫu mới!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/xoa-tat-ca-xe-mau', verifyAdmin, async (req, res) => {
  try {
    const raw = await getRawData();
    raw.danhMucXeMau = [];
    await saveRawDataFast(raw);
    await recordLog(req, 'Xóa tất cả danh mục mác xe mẫu');
    res.json({ success: true, message: "Đã dọn sạch danh mục mác xe mẫu thành công!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- QUẢN LÝ ĐỘI XE THEO TUYẾN & HẸN GIỜ ĐIỀU CHUYỂN BẾN DP ---
app.post('/api/admin/luu-doi-xe-tuyen', verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, danhSachXe, ngayApDung } = req.body;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    if (!Array.isArray(raw.danhMucXeMau)) raw.danhMucXeMau = [];

    const normMaTuyen = String(maTuyen).trim().toUpperCase();

    // 1. Chuẩn hóa ngày áp dụng (hỗ trợ định dạng dd/mm/yyyy từ frontend gửi lên)
    const today = new Date().toISOString().split('T')[0];
    function parseDateToISO(dateStr) {
      if (!dateStr) return today;
      let s = String(dateStr).trim();
      if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length === 3) {
          let d = parts[0].padStart(2, '0');
          let m = parts[1].padStart(2, '0');
          let y = parts[2];
          if (y.length === 2) y = '20' + y;
          return `${y}-${m}-${d}`;
        }
      }
      return s;
    }

    const ngayHieuLuc = ngayApDung ? parseDateToISO(ngayApDung) : today;

    // 2. Xử lý danh sách xe mới được gửi lên
    const newCarsForRoute = (danhSachXe || []).map(x => {
      let bksUpper = String(x.bks || '').trim().toUpperCase();
      let inputChungLoai = x.chungLoai || '';
      let inputNamSx = String(x.namSx || '').trim();

      let mauChuan = raw.danhMucXeMau.find(m => 
        m.chungLoai.toLowerCase() === inputChungLoai.toLowerCase() && 
        String(m.namSx || '').trim() === inputNamSx
      );

      return {
        bks: bksUpper,
        maTuyen: normMaTuyen,
        chungLoai: mauChuan ? mauChuan.chungLoai : inputChungLoai,
        sucChua: mauChuan ? mauChuan.sucChua : (x.sucChua || ''),
        nhanHieu: x.nhanHieu || '',
        namSx: mauChuan ? mauChuan.namSx : inputNamSx
      };
    }).filter(x => x.bks);

    const bksXeMoiSet = new Set(newCarsForRoute.map(x => x.bks));

    // 3. Phân nhánh: Nếu có hẹn giờ trong tương lai -> Lưu vào bảng chờ lịch trình
    if (ngayHieuLuc > today) {
      if (!Array.isArray(raw.scheduledFleetUpdates)) {
        raw.scheduledFleetUpdates = [];
      }
      raw.scheduledFleetUpdates.push({
        id: Date.now().toString(),
        maTuyen: normMaTuyen,
        danhSachXe: newCarsForRoute,
        ngayApDung: ngayHieuLuc,
        status: 'pending',
        createdAt: new Date()
      });

      await saveRawData(raw);
      await recordLog(req, `Lên lịch hẹn đội xe tuyến [${normMaTuyen}] từ ngày ${ngayApDung}`);
      return res.json({ 
        success: true, 
        message: `Đã lên lịch thành công! Đội xe sẽ tự động áp dụng và đẩy xe cũ về bến DP vào ngày ${ngayApDung}.` 
      });
    }

    // 4. Nếu áp dụng ngay lập tức:
    const otherCars = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() !== normMaTuyen);
    const xeCuCuaTuyen = raw.xeList.filter(x => String(x.maTuyen || '').trim().toUpperCase() === normMaTuyen);

    const finalXeList = [...otherCars];
    finalXeList.push(...newCarsForRoute);

    // Tự động đẩy các xe cũ không còn có mặt trong danh sách mới về bến 'DP' (Dự phòng)
    xeCuCuaTuyen.forEach(xeCu => {
      if (!bksXeMoiSet.has(xeCu.bks)) {
        finalXeList.push({
          ...xeCu,
          maTuyen: 'DP', // 👉 Đẩy về bến Dự Phòng
          updatedAt: new Date()
        });
      }
    });

    raw.xeList = finalXeList;

    if (raw.tuyenList && raw.tuyenList[normMaTuyen]) {
      raw.tuyenList[normMaTuyen].soXeKh = newCarsForRoute.length;
      raw.tuyenList[normMaTuyen].soXe = newCarsForRoute.length;
    }

    await saveRawData(raw);
    await recordLog(req, `Cập nhật đội xe tuyến [${normMaTuyen}] (${newCarsForRoute.length} xe), tự động đẩy xe thừa về DP`);
    res.json({ success: true, message: `Lưu đội xe tuyến ${normMaTuyen} thành công (${newCarsForRoute.length} xe), xe cũ đã được tự động điều chuyển về bến DP!` });
  } catch (err) {
    console.error('Lỗi lưu đội xe:', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
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
						tramDi: item.tramDi || "", // 👉 Đã bổ sung trạm đi
						tramVe: item.tramVe || "", // 👉 Đã bổ sung trạm về
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

// Thêm API chi tiết tuyến phòng hờ
app.get('/api/chi-tiet-tuyen', async (req, res) => {
	try {
		const maTuyen = req.query.maTuyen || req.query.tuyen;
		if (!maTuyen) return res.json({ success: false, message: "Thiếu mã tuyến!" });

		const raw = await getRawData();
		let tuyenInfo = null;

		if (raw.tuyenList) {
			for (let k in raw.tuyenList) {
				const t = raw.tuyenList[k];
				if (String(t.maTuyen || k).toUpperCase() === String(maTuyen).toUpperCase() ||
					String(t.tenTuyen || '').toUpperCase().includes(String(maTuyen).toUpperCase())) {
					tuyenInfo = t;
					break;
				}
			}
		}

		if (!tuyenInfo) {
			return res.json({
				success: true,
				maTuyen: maTuyen,
				tenTuyen: maTuyen,
				dauA: "Đầu A",
				dauB: "Đầu B",
				tramDi: "",
				tramVe: ""
			});
		}

		res.json({
			success: true,
			maTuyen: tuyenInfo.maTuyen || maTuyen,
			tenTuyen: tuyenInfo.tenTuyen || maTuyen,
			dauA: tuyenInfo.dauA || "Đầu A",
			dauB: tuyenInfo.dauB || "Đầu B",
			tramDi: tuyenInfo.tramDi || "", // 👉 Trả về danh sách trạm chiều đi
			tramVe: tuyenInfo.tramVe || ""  // 👉 Trả về danh sách trạm chiều về
		});
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

app.post(['/api/bus-data', '/api/save-data'], verifyAdmin, async (req, res) => {
  try { 
    await saveRawData(req.body); 
    await recordLog(req, 'Lưu dữ liệu tổng hệ thống');
    res.json({ success: true, message: 'Lưu thành công!' }); 
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post(['/api/save-tuyen', '/api/tuyen-moi'], verifyAdmin, async (req, res) => {
  try {
    // 👉 Thêm tramDi và tramVe vào đây
    const { maTuyen, tenTuyen, xn, dauA, dauB, tramDi, tramVe, soXeVd, soXeKh, loaiXe, sucChua, status } = req.body;
    if (!maTuyen) return res.status(400).json({ success: false, message: 'Thiếu mã tuyến!' });

    const raw = await getRawData();
    if (!raw.tuyenList) raw.tuyenList = {};

    raw.tuyenList[maTuyen] = {
      maTuyen, 
      tenTuyen: tenTuyen || `${maTuyen}. Tuyến ${maTuyen}`,
      xn:xn || "", 
      dauA: dauA || "", 
      dauB: dauB || "",
      tramDi: tramDi || "", // 👉 Lưu trạm đi
      tramVe: tramVe || "", // 👉 Lưu trạm về
      soXeVd: parseInt(soXeVd, 10) || raw.tuyenList[maTuyen]?.soXeVd || 0,
      soXeKh: parseInt(soXeKh, 10) || 0, 
      soXe: parseInt(soXeKh, 10) || 0,
      loaiXe: loaiXe || "", 
      sucChua: sucChua || "", 
      status: status || "active"
    };

    await saveRawDataFast(raw);
    await recordLog(req, `Lưu thông tin tuyến [${maTuyen}]`);
    res.json({ success: true, message: 'Lưu tuyến thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/toggle-status-tuyen', verifyAdmin, async (req, res) => {
  try {
    const { maTuyen, status } = req.body;
    const raw = await getRawData();
    if (!raw.tuyenList || !raw.tuyenList[maTuyen]) return res.status(404).json({ success: false, message: 'Không tìm thấy mã tuyến!' });
    raw.tuyenList[maTuyen].status = status;
    await saveRawDataFast(raw);
    await recordLog(req, `Đổi trạng thái tuyến [${maTuyen}] sang [${status}]`);
    res.json({ success: true, message: 'Cập nhật trạng thái thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/luu-bieu-do', verifyAdmin, async (req, res) => {
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
    await recordLog(req, `Lưu biểu đồ chạy xe [${tenTab}]`);
    res.json({ success: true, message: 'Lưu biểu đồ thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-bieu-do', verifyAdmin, async (req, res) => {
  try {
    const { tenTab } = req.body;
    const raw = await getRawData();
    if (!Array.isArray(raw.bieuDoList)) raw.bieuDoList = [];
    raw.bieuDoList = raw.bieuDoList.filter(b => String(b.tenTab || '').trim() !== String(tenTab).trim());
    await saveRawDataFast(raw);
    await recordLog(req, `Xóa biểu đồ [${tenTab}]`);
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

app.post(['/api/import-xe-excel', '/api/import-danh-sach-xe'], verifyAdmin, async (req, res) => {
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
        message: 'Không tìm thấy thông tin tuyến ở dòng tiêu đề!' 
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
    await recordLog(req, `Import ${importedCars.length} xe vào tuyến [${currentMaTuyen}] từ Excel`);
    res.json({ success: true, message: `Bóc tách và nạp thành công ${importedCars.length} xe vào tuyến ${currentMaTuyen}!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/xoa-xe', verifyAdmin, async (req, res) => {
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
    await recordLog(req, `Xóa xe [${bks}] khỏi hệ thống`);
    res.json({ success: true, message: `Đã xóa thành công xe [${bks}] khỏi hệ thống!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe', verifyAdmin, async (req, res) => {
  try {
    const { bks, tuyenMoi } = req.body;
    if (!bks || !tuyenMoi) return res.status(400).json({ success: false, message: 'Thiếu thông tin điều chuyển!' });
    const raw = await getRawData();
    if (!Array.isArray(raw.xeList)) raw.xeList = [];
    const xe = raw.xeList.find(x => String(x.bks || '').trim().toUpperCase() === String(bks).trim().toUpperCase());
    if (!xe) return res.status(404).json({ success: false, message: 'Không tìm thấy biển kiểm soát xe!' });
    xe.maTuyen = String(tuyenMoi).trim().toUpperCase();
    await saveRawDataFast(raw);
    await recordLog(req, `Điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}]`);
    res.json({ success: true, message: `Đã điều chuyển xe [${bks}] sang tuyến [${tuyenMoi}] thành công!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/dieu-chuyen-xe-hang-loat', verifyAdmin, async (req, res) => {
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
    await recordLog(req, `Điều chuyển hàng loạt ${count} xe sang tuyến [${tuyenMoi}]`);
    res.json({ success: true, message: `Đã điều chuyển thành công ${count} xe sang tuyến [${tuyenMoi}]!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => {
  console.log(`=== SERVER RUNNING ON PORT ${PORT} ===`);
});
