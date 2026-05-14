const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const open = require('open');
const rateLimit = require('express-rate-limit');
const cookieParser = (() => {
  // Lightweight cookie parser — no need for new dependency
  return function (req, res, next) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach(p => {
      const idx = p.indexOf('=');
      if (idx > 0) {
        const k = p.slice(0, idx).trim();
        const v = decodeURIComponent(p.slice(idx + 1).trim());
        if (k) out[k] = v;
      }
    });
    req.cookies = out;
    next();
  };
})();

const db = require('./db');
const {
  getLocalIPs,
  pickPrimaryIP,
  genSessionCode,
  genStudentNumber,
  isLocalRequest,
  normalize,
  sanitizeQuizForStudent,
  autoScore
} = require('./util');

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, '..', 'public');

// Asılı socket / yakalanmamış hatalar process'i düşürmesin
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message);
  try { logEvent('error', 'server', err.message, { stack: err.stack, type: 'uncaughtException' }); }
  catch (e) {}
});
process.on('unhandledRejection', err => {
  const msg = err?.message || String(err);
  console.error('[unhandledRejection]', msg);
  try { logEvent('error', 'server', msg, { stack: err?.stack, type: 'unhandledRejection' }); }
  catch (e) {}
});

const app = express();
// trust proxy AÇIK BIRAKMA — X-Forwarded-For spoof'ı admin bypass'a yol açar
// Resim dataURL yüklemesi için 8 MB (2 MB binary base64 ~ 2.7 MB)
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser);

// ====================================================================
//  STUDENT SESSION TOKEN STORE — IDOR fix
//  Login sırasında üretilen token, resultId ile eşleşmeli.
//  In-memory yeterli (sunucu restart olunca öğrenciler tekrar login olur).
// ====================================================================
const studentTokens = new Map(); // token → { resultId, studentId, createdAt }
const STUDENT_TOKEN_COOKIE = 'qsid';
const STUDENT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 saat

function issueStudentToken(resultId, studentId) {
  const token = nanoid(32);
  studentTokens.set(token, { resultId, studentId, createdAt: Date.now() });
  return token;
}
function getStudentTokenFromReq(req) {
  // Önce cookie, sonra header (öğrenci client'ı header da gönderebilir)
  const fromCookie = req.cookies?.[STUDENT_TOKEN_COOKIE];
  if (fromCookie) return fromCookie;
  const h = req.get('x-student-token');
  return h || null;
}
function validateStudentToken(req, resultId) {
  const token = getStudentTokenFromReq(req);
  if (!token) return false;
  const rec = studentTokens.get(token);
  if (!rec) return false;
  if (Date.now() - rec.createdAt > STUDENT_TOKEN_TTL_MS) {
    studentTokens.delete(token);
    return false;
  }
  return rec.resultId === resultId;
}
function revokeStudentTokensForResult(resultId) {
  for (const [k, v] of studentTokens) {
    if (v.resultId === resultId) studentTokens.delete(k);
  }
}
// periyodik temizlik
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of studentTokens) {
    if (now - v.createdAt > STUDENT_TOKEN_TTL_MS) studentTokens.delete(k);
  }
}, 30 * 60 * 1000).unref?.();

// ====================================================================
//  RATE LIMITING (Bulgu 3, 9)
// ====================================================================
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // login: 30/dakika/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi. Bir dakika sonra tekrar dene.' }
});
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla kayıt isteği. Bir dakika sonra tekrar dene.' }
});
const logLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'log limit' }
});
const answerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // bir öğrenci dakikada en fazla 240 cevap kaydı (4/saniye)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'çok hızlı' }
});
const activeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'çok fazla istek' }
});

// LAN'dan gelirse öğrenci sayfası, localhost ise admin
app.get('/', (req, res) => {
  if (isLocalRequest(req)) {
    res.sendFile(path.join(publicDir, 'admin.html'));
  } else {
    res.sendFile(path.join(publicDir, 'student.html'));
  }
});

// Admin-only statik dosyalar — LAN'dan istenirse 403
const adminAssets = new Set(['/admin.html', '/js/admin.js']);
app.use((req, res, next) => {
  if (adminAssets.has(req.path) && !isLocalRequest(req)) {
    return res.status(403).send('forbidden');
  }
  next();
});
app.use(express.static(publicDir));

// Yüklenen resimler — herkese servis (öğrenci de görmeli)
const fs = require('fs');
const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '7d',
  immutable: true
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ====================================================================
//  ADMIN-ONLY middleware
// ====================================================================
function adminOnly(req, res, next) {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ====================================================================
//  LOG SİSTEMİ
// ====================================================================
const MAX_LOGS = 500;
function logEvent(level, source, message, context = {}) {
  const entry = {
    id: nanoid(8),
    ts: Date.now(),
    level: level || 'info',
    source: source || 'server',
    message: String(message || ''),
    context
  };
  try {
    db.get('logs').push(entry).write();
    // FIFO cap — son MAX_LOGS tut
    const logs = db.get('logs').value();
    if (logs.length > MAX_LOGS) {
      db.set('logs', logs.slice(-MAX_LOGS)).write();
    }
    const tag = `[${level.toUpperCase()}/${source}]`;
    if (level === 'error') console.error(tag, message, context);
    else console.log(tag, message);
  } catch (e) {
    console.error('logEvent failed', e);
  }
  return entry;
}

// ====================================================================
//  Student ID encoding ve resolve
//  - Eski sonuçlar için: stuId = base64url(name|sinif)  (backward compat)
//  - Yeni öğrenciler için: stuId = numara (6 hane)
//  resolveStudent() ikisini de kabul eder
// ====================================================================
function isNumericId(id) { return /^\d{6}$/.test(id); }

function studentKeyToId(name, sinif) {
  // Eğer bu name+sinif için kayıtlı bir student varsa onun numarasını dön
  const stu = db.get('students').find(s =>
    (s.name || '').toLowerCase().trim() === (name || '').toLowerCase().trim() &&
    (s.sinif || '').toLowerCase().trim() === (sinif || '').toLowerCase().trim()
  ).value();
  if (stu) return stu.id;
  // Yoksa eski base64 yaklaşımı (henüz kaydolmamış)
  const key = (name || '').toLowerCase().trim() + '|' + (sinif || '').toLowerCase().trim();
  return Buffer.from(key, 'utf8').toString('base64url');
}
function studentIdToKey(id) {
  try { return Buffer.from(id, 'base64url').toString('utf8'); }
  catch (e) { return null; }
}
function matchStudent(r, name, sinif) {
  return (r.name || '').toLowerCase().trim() === name &&
         (r.sinif || '').toLowerCase().trim() === sinif;
}

// stuId verilirse student kaydını veya derive edilmiş bilgiyi döner
function resolveStudent(stuId) {
  if (isNumericId(stuId)) {
    const stu = db.get('students').find({ id: stuId }).value();
    if (stu) return { kind: 'student', name: stu.name, sinif: stu.sinif, student: stu };
    return null;
  }
  const decoded = studentIdToKey(stuId);
  if (!decoded) return null;
  const [name, sinif] = decoded.split('|');
  // Belki bu name+sinif zaten students içine kaydolmuş, onu öncelikle al
  const stu = db.get('students').find(s =>
    (s.name || '').toLowerCase().trim() === name &&
    (s.sinif || '').toLowerCase().trim() === sinif
  ).value();
  if (stu) return { kind: 'student', name: stu.name, sinif: stu.sinif, student: stu };
  return { kind: 'derived', name, sinif, student: null };
}

// ====================================================================
//  STARTUP MIGRATION — eski results'a studentId yaz
// ====================================================================
function runMigration() {
  const students = db.get('students').value();
  const results = db.get('results').value();
  let createdStudents = 0;
  let linkedResults = 0;

  for (const r of results) {
    if (r.studentId) continue;
    // İsim/sınıf eşleşmesi
    let stu = students.find(s =>
      (s.name || '').toLowerCase().trim() === (r.name || '').toLowerCase().trim() &&
      (s.sinif || '').toLowerCase().trim() === (r.sinif || '').toLowerCase().trim()
    );
    if (!stu) {
      const numbers = students.map(s => s.id);
      try {
        const newId = genStudentNumber(numbers);
        stu = {
          id: newId,
          name: r.name,
          sinif: r.sinif || '',
          createdAt: r.joinedAt || r.submittedAt || Date.now(),
          createdBy: 'migration'
        };
        students.push(stu);
        createdStudents++;
      } catch (e) { continue; }
    }
    r.studentId = stu.id;
    linkedResults++;
  }
  if (createdStudents || linkedResults) {
    db.set('students', students).set('results', results).write();
    logEvent('info', 'server', 'Migration: eski sonuçlar öğrencilerle eşleştirildi', {
      createdStudents, linkedResults
    });
  }
}
runMigration();

// ====================================================================
//  ADMIN API
// ====================================================================

// Genel durum — dashboard
app.get('/api/admin/state', adminOnly, async (req, res) => {
  const quizzes = db.get('quizzes').value();
  const sessions = db.get('sessions').value();
  const results = db.get('results').value();

  const activeSession = sessions.find(s => s.status === 'live') || null;
  let activeMeta = null;
  let activeQuizTitle = null;
  if (activeSession) {
    const activeQuiz = quizzes.find(q => q.id === activeSession.quizId);
    activeQuizTitle = activeQuiz?.title;
    const ip = pickPrimaryIP();
    const url = `http://${ip}:${PORT}/`;
    const qr = await QRCode.toDataURL(url, { width: 280, margin: 1 });
    activeMeta = {
      joinUrl: url,
      ips: getLocalIPs().map(i => i.address),
      port: PORT,
      qrDataUrl: qr,
      quizTitle: activeQuizTitle,
      participantCount: results.filter(r => r.sessionId === activeSession.id).length,
      submittedCount: results.filter(r => r.sessionId === activeSession.id && r.status !== 'in_progress').length
    };
  }

  // Öğrenci listesi (Ad Soyad + Sınıf benzersizliği)
  const studentMap = {};
  for (const r of results) {
    const key = studentKeyToId(r.name, r.sinif);
    if (!studentMap[key]) studentMap[key] = {
      stuId: key,
      name: r.name,
      sinif: r.sinif,
      sessions: [],
      totalScore: 0,
      quizCount: 0
    };
    studentMap[key].sessions.push({
      sessionId: r.sessionId,
      resultId: r.id,
      score: r.totalScore || 0,
      status: r.status,
      submittedAt: r.submittedAt
    });
    studentMap[key].totalScore += r.totalScore || 0;
    studentMap[key].quizCount++;
  }
  const students = Object.values(studentMap).sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  res.json({
    quizzes: quizzes.map(q => ({
      id: q.id,
      title: q.title,
      timeMode: q.timeMode,
      timeValue: q.timeValue,
      questionCount: q.questions.length,
      createdAt: q.createdAt
    })),
    activeSession: activeSession ? { ...activeSession, meta: activeMeta } : null,
    sessions: sessions
      .filter(s => s.status === 'finished' && s.kind !== 'registration' && s.quizId)
      .filter(s => quizzes.find(q => q.id === s.quizId)) // quiz silinmişse oturum da listede görünmesin
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
      .map(s => {
        const quiz = quizzes.find(q => q.id === s.quizId);
        const sResults = results.filter(r => r.sessionId === s.id);
        return {
          id: s.id,
          code: s.code,
          quizId: s.quizId,
          quizTitle: quiz?.title || '(silinmiş quiz)',
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          participantCount: sResults.length,
          ungradedCount: sResults.reduce((acc, r) => acc + (r.status === 'awaiting_grading' ? 1 : 0), 0)
        };
      }),
    students
  });
});

// Quiz CRUD
app.get('/api/admin/quizzes/:id', adminOnly, (req, res) => {
  const quiz = db.get('quizzes').find({ id: req.params.id }).value();
  if (!quiz) return res.status(404).json({ error: 'bulunamadı' });
  res.json(quiz);
});

// Yüklenmiş resim filename'i mi? (sadece nanoid + ext patern'i)
function isValidUploadedFilename(f) {
  return typeof f === 'string' && /^[A-Za-z0-9_-]{6,32}\.(jpg|png|webp|gif)$/.test(f);
}

// Bulgu 6, 16, 17: Quiz validasyonu — merkezi
function validateAndCleanQuiz(body) {
  const { title, timeMode, timeValue, shuffleQuestions, shuffleOptions, questions } = body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw Object.assign(new Error('Başlık gerekli'), { httpStatus: 400 });
  }
  if (title.trim().length > 200) {
    throw Object.assign(new Error('Başlık çok uzun'), { httpStatus: 400 });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw Object.assign(new Error('En az bir soru gerekli'), { httpStatus: 400 });
  }
  if (questions.length > 200) {
    throw Object.assign(new Error('Çok fazla soru (en fazla 200)'), { httpStatus: 400 });
  }
  const validModes = ['unlimited', 'total', 'per_question'];
  if (!validModes.includes(timeMode)) {
    throw Object.assign(new Error('Geçersiz süre modu'), { httpStatus: 400 });
  }
  // Bulgu 17: timeValue range
  let tv = Number(timeValue);
  if (timeMode === 'unlimited') tv = 0;
  else if (timeMode === 'total') {
    if (!Number.isFinite(tv) || tv < 1 || tv > 600) {
      throw Object.assign(new Error('Toplam süre 1 ile 600 dakika arasında olmalı'), { httpStatus: 400 });
    }
  } else if (timeMode === 'per_question') {
    if (!Number.isFinite(tv) || tv < 5 || tv > 600) {
      throw Object.assign(new Error('Soru başına süre 5 ile 600 saniye arasında olmalı'), { httpStatus: 400 });
    }
  }

  const cleanQuestions = questions.map((q, qi) => {
    if (!q || typeof q !== 'object') throw Object.assign(new Error(`Soru ${qi + 1} geçersiz`), { httpStatus: 400 });
    const id = (typeof q.id === 'string' && q.id.length <= 32) ? q.id : nanoid(6);
    const text = (q.text == null ? '' : String(q.text)).trim();
    // Bulgu 16: boş soru metni reddet
    if (!text) throw Object.assign(new Error(`Soru ${qi + 1}: metin boş`), { httpStatus: 400 });
    if (text.length > 2000) throw Object.assign(new Error(`Soru ${qi + 1}: metin çok uzun`), { httpStatus: 400 });
    // Bulgu 6, 16: points >= 1, sayısal
    const pointsN = Number(q.points);
    const points = Number.isFinite(pointsN) && pointsN >= 1 ? Math.min(Math.floor(pointsN), 1000) : 1;
    if (Number.isFinite(pointsN) && pointsN < 1) {
      throw Object.assign(new Error(`Soru ${qi + 1}: puan en az 1 olmalı`), { httpStatus: 400 });
    }
    const base = { id, type: q.type, text, points };
    // Opsiyonel soru resmi
    if (q.image && isValidUploadedFilename(q.image)) {
      base.image = q.image;
    }
    if (q.type === 'multiple_choice') {
      // Şıklar: text ve/veya image olabilir. Hiçbiri yoksa atla.
      const rawOpts = q.options || [];
      const rawImgs = q.optionImages || [];
      const opts = [];
      const optImgs = [];
      for (let i = 0; i < rawOpts.length; i++) {
        const t = (rawOpts[i] == null ? '' : String(rawOpts[i])).trim();
        const img = (rawImgs[i] && isValidUploadedFilename(rawImgs[i])) ? rawImgs[i] : null;
        if (!t && !img) continue; // hem text hem image yoksa şık değil
        if (t.length > 500) throw Object.assign(new Error(`Soru ${qi + 1}: şık metni çok uzun`), { httpStatus: 400 });
        opts.push(t);
        optImgs.push(img);
      }
      if (opts.length < 2) throw Object.assign(new Error(`Soru ${qi + 1}: çoktan seçmeli en az 2 şık gerekli (metin veya resim)`), { httpStatus: 400 });
      if (opts.length > 12) throw Object.assign(new Error(`Soru ${qi + 1}: en fazla 12 şık`), { httpStatus: 400 });
      base.options = opts;
      if (optImgs.some(Boolean)) base.optionImages = optImgs;
      const ci = Number(q.correctIndex);
      if (!Number.isFinite(ci) || ci < 0 || ci >= opts.length) {
        throw Object.assign(new Error(`Soru ${qi + 1}: doğru şık seçilmemiş veya geçersiz`), { httpStatus: 400 });
      }
      base.correctIndex = Math.floor(ci);
    } else if (q.type === 'true_false') {
      if (q.correctBool !== true && q.correctBool !== false && q.correctBool !== 'true' && q.correctBool !== 'false') {
        throw Object.assign(new Error(`Soru ${qi + 1}: doğru/yanlış seçilmemiş`), { httpStatus: 400 });
      }
      base.correctBool = q.correctBool === true || q.correctBool === 'true';
    } else if (q.type === 'open_ended') {
      // manuel puanlama
    } else {
      throw Object.assign(new Error(`Soru ${qi + 1}: bilinmeyen tip "${q.type}"`), { httpStatus: 400 });
    }
    return base;
  });

  return {
    title: title.trim(),
    timeMode,
    timeValue: tv,
    shuffleQuestions: !!shuffleQuestions,
    shuffleOptions: !!shuffleOptions,
    questions: cleanQuestions
  };
}

app.post('/api/admin/quizzes', adminOnly, (req, res) => {
  let clean;
  try { clean = validateAndCleanQuiz(req.body); }
  catch (e) { return res.status(e.httpStatus || 400).json({ error: e.message }); }
  const quiz = { id: nanoid(8), ...clean, createdAt: Date.now() };
  db.get('quizzes').push(quiz).write();
  res.json(quiz);
});

app.put('/api/admin/quizzes/:id', adminOnly, (req, res) => {
  const quizRef = db.get('quizzes').find({ id: req.params.id });
  if (!quizRef.value()) return res.status(404).json({ error: 'bulunamadı' });

  let clean;
  try { clean = validateAndCleanQuiz(req.body); }
  catch (e) { return res.status(e.httpStatus || 400).json({ error: e.message }); }
  quizRef.assign(clean).write();
  res.json(quizRef.value());
});

app.delete('/api/admin/quizzes/:id', adminOnly, (req, res) => {
  const quizId = req.params.id;
  const quiz = db.get('quizzes').find({ id: quizId }).value();
  if (!quiz) return res.status(404).json({ error: 'Quiz bulunamadı' });

  const deleteResults = req.query.deleteResults === 'true';

  // Bu quizin tüm oturumlarını bul
  const sessionIds = db.get('sessions').filter({ quizId }).map('id').value();
  const resultsCount = db.get('results').filter(r => sessionIds.includes(r.sessionId)).size().value();

  if (deleteResults) {
    db.get('results').remove(r => sessionIds.includes(r.sessionId)).write();
  }
  // Sessions her zaman silinir — quiz'i silinen oturum geçmişte tutulmaz
  db.get('sessions').remove({ quizId }).write();
  // Quiz sil
  db.get('quizzes').remove({ id: quizId }).write();

  logEvent('warn', 'admin',
    deleteResults
      ? `Öğretmen "${quiz.title}" quizini sildi (${sessionIds.length} oturum + ${resultsCount} öğrenci sonucu da silindi)`
      : `Öğretmen "${quiz.title}" quizini sildi (${sessionIds.length} oturum silindi, ${resultsCount} öğrenci sonucu KORUNDU)`,
    { quizId, sessionsDeleted: sessionIds.length, resultsDeleted: deleteResults ? resultsCount : 0 }
  );
  res.json({ ok: true, sessionsDeleted: sessionIds.length, resultsCount, resultsDeleted: deleteResults });
});

// === RESİM YÜKLEME ===
// Client base64 dataURL gönderir, server diske yazar, filename döner.
const ACCEPTED_IMAGE_MIMES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB binary

app.post('/api/admin/upload', adminOnly, (req, res) => {
  const { dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ error: 'dataUrl gerekli' });
  }
  const match = dataUrl.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Geçersiz dataURL formatı' });
  const mime = match[1].toLowerCase();
  const ext = ACCEPTED_IMAGE_MIMES[mime];
  if (!ext) return res.status(400).json({ error: 'Desteklenmeyen resim türü (jpg, png, webp, gif kabul)' });

  let buf;
  try { buf = Buffer.from(match[2], 'base64'); }
  catch (e) { return res.status(400).json({ error: 'base64 decode hatası' }); }
  if (buf.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: `Resim çok büyük (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` });
  }

  // Magic-byte kontrolü (mime spoof'a karşı)
  const head = buf.slice(0, 12);
  const isJPG = head[0] === 0xFF && head[1] === 0xD8;
  const isPNG = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isGIF = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  const isWEBP = head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP';
  if (!(isJPG || isPNG || isGIF || isWEBP)) {
    return res.status(400).json({ error: 'Dosya gerçek bir resim değil (header eşleşmedi)' });
  }

  const filename = nanoid(14) + '.' + ext;
  const fullPath = path.join(uploadsDir, filename);
  try {
    fs.writeFileSync(fullPath, buf);
  } catch (e) {
    logEvent('error', 'admin', 'Resim diske yazılamadı', { error: e.message });
    return res.status(500).json({ error: 'Resim kaydedilemedi' });
  }
  logEvent('info', 'admin', `Resim yüklendi: ${filename} (${Math.round(buf.length / 1024)} KB, ${mime})`, { filename, size: buf.length });
  res.json({ filename, url: '/uploads/' + filename, size: buf.length });
});

// Resim silme
app.delete('/api/admin/upload/:filename', adminOnly, (req, res) => {
  const fname = req.params.filename;
  // Path traversal koruması
  if (!/^[A-Za-z0-9_-]+\.(jpg|png|webp|gif)$/.test(fname)) {
    return res.status(400).json({ error: 'Geçersiz dosya adı' });
  }
  const fullPath = path.join(uploadsDir, fname);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) {
    return res.status(500).json({ error: 'Silinemedi' });
  }
  res.json({ ok: true });
});

// Quiz silme öncesi etki sorgusu (UI modal için)
app.get('/api/admin/quizzes/:id/delete-impact', adminOnly, (req, res) => {
  const quiz = db.get('quizzes').find({ id: req.params.id }).value();
  if (!quiz) return res.status(404).json({ error: 'Quiz yok' });
  const sessionIds = db.get('sessions').filter({ quizId: req.params.id }).map('id').value();
  const resultsCount = db.get('results').filter(r => sessionIds.includes(r.sessionId)).size().value();
  res.json({
    quizTitle: quiz.title,
    sessions: sessionIds.length,
    results: resultsCount
  });
});

// Bulgu 13: paralel session start race koruması (in-memory mutex)
let _sessionStartLock = false;

// Oturum başlat (quiz veya registration)
app.post('/api/admin/sessions/start', adminOnly, async (req, res) => {
  if (_sessionStartLock) {
    return res.status(409).json({ error: 'Başka bir oturum başlatma işlemi sürüyor, birkaç saniye sonra dene' });
  }
  _sessionStartLock = true;
  try {
  const { quizId, kind, acceptNewRegistrations } = req.body || {};
  const sessionKind = kind === 'registration' ? 'registration' : 'quiz';
  let quiz = null;
  if (sessionKind === 'quiz') {
    if (typeof quizId !== 'string' || !quizId) return res.status(400).json({ error: 'quizId gerekli' });
    quiz = db.get('quizzes').find({ id: quizId }).value();
    if (!quiz) return res.status(404).json({ error: 'quiz yok' });
  }

  // Aktif oturum varsa bitir
  db.get('sessions').filter({ status: 'live' }).each(s => {
    s.status = 'finished';
    s.endedAt = Date.now();
  }).write();

  const session = {
    id: nanoid(10),
    code: genSessionCode(),
    kind: sessionKind,
    quizId: sessionKind === 'quiz' ? quizId : null,
    acceptNewRegistrations: sessionKind === 'quiz' ? !!acceptNewRegistrations : true,
    status: 'live',
    startedAt: Date.now(),
    endedAt: null
  };
  db.get('sessions').push(session).write();
  if (sessionKind === 'registration') {
    logEvent('info', 'admin',
      `Öğretmen yeni kayıt oturumu açtı (kod: ${session.code})`,
      { sessionId: session.id, code: session.code }
    );
  } else {
    logEvent('info', 'admin',
      `Öğretmen "${quiz?.title}" quizini başlattı (kod: ${session.code}${session.acceptNewRegistrations ? ', hibrit: yeni kayıt KABUL' : ', sıkı mod: sadece kayıtlılar'})`,
      { sessionId: session.id, code: session.code, quizId, acceptNewRegistrations: session.acceptNewRegistrations }
    );
  }

  const ip = pickPrimaryIP();
  const url = `http://${ip}:${PORT}/`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 });

  io.emit('session:started', { code: session.code });

  res.json({
    session,
    meta: { joinUrl: url, ips: getLocalIPs().map(i => i.address), port: PORT, qrDataUrl }
  });
  } finally {
    _sessionStartLock = false;
  }
});

// Bulgu 19: Live session'da acceptNewRegistrations toggle edebilme
app.patch('/api/admin/sessions/:id', adminOnly, (req, res) => {
  const sRef = db.get('sessions').find({ id: req.params.id });
  const s = sRef.value();
  if (!s) return res.status(404).json({ error: 'oturum yok' });
  if (s.status !== 'live') return res.status(400).json({ error: 'sadece canlı oturum güncellenebilir' });
  const patch = {};
  if (typeof req.body?.acceptNewRegistrations === 'boolean') {
    patch.acceptNewRegistrations = req.body.acceptNewRegistrations;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'değiştirilecek alan yok' });
  sRef.assign(patch).write();
  logEvent('info', 'admin',
    `Oturum ayarı güncellendi (acceptNewRegistrations=${patch.acceptNewRegistrations})`,
    { sessionId: s.id });
  res.json({ ok: true, session: sRef.value() });
});

// Oturum bitir
app.post('/api/admin/sessions/:id/end', adminOnly, (req, res) => {
  const sRef = db.get('sessions').find({ id: req.params.id });
  if (!sRef.value()) return res.status(404).json({ error: 'oturum yok' });
  sRef.assign({ status: 'finished', endedAt: Date.now() }).write();
  // İn-progress sonuçları "auto-submit" olarak işle
  db.get('results')
    .filter(r => r.sessionId === req.params.id && r.status === 'in_progress')
    .each(r => { r.status = 'submitted'; r.submittedAt = Date.now(); })
    .write();
  recomputeResults(req.params.id);
  io.emit('session:ended', { sessionId: req.params.id });
  res.json({ ok: true });
});

// Oturum detayı (puanlama için)
app.get('/api/admin/sessions/:id', adminOnly, (req, res) => {
  const session = db.get('sessions').find({ id: req.params.id }).value();
  if (!session) return res.status(404).json({ error: 'oturum yok' });
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  const results = db.get('results').filter({ sessionId: session.id }).value();
  res.json({ session, quiz, results });
});

// Belirli bir sonuç (öğrenci submission) detayı
app.get('/api/admin/results/:id', adminOnly, (req, res) => {
  const result = db.get('results').find({ id: req.params.id }).value();
  if (!result) return res.status(404).json({ error: 'sonuç yok' });
  const session = db.get('sessions').find({ id: result.sessionId }).value();
  const quiz = db.get('quizzes').find({ id: session?.quizId }).value();
  res.json({ result, quiz, session });
});

// Açık uçlu puanlama (Bulgu 7)
app.post('/api/admin/results/:id/grade', adminOnly, (req, res) => {
  const ref = db.get('results').find({ id: req.params.id });
  const result = ref.value();
  if (!result) return res.status(404).json({ error: 'sonuç yok' });

  const session = db.get('sessions').find({ id: result.sessionId }).value();
  const quiz = session ? db.get('quizzes').find({ id: session.quizId }).value() : null;

  const { grades } = req.body || {};
  if (!Array.isArray(grades)) return res.status(400).json({ error: 'grades dizi olmalı' });

  // Boyut sınırı (DoS koruması)
  if (grades.length > 500) return res.status(413).json({ error: 'çok fazla puan girişi' });

  const validQuestionIds = new Set((quiz?.questions || []).map(q => q.id));
  const pointsByQ = Object.fromEntries((quiz?.questions || []).map(q => [q.id, q.points || 1]));

  // Prototype pollution koruması — Object.create(null)
  const grading = Object.assign(Object.create(null), result.grading || {});
  for (const g of grades) {
    if (!g || typeof g !== 'object') continue;
    const qid = String(g.questionId || '');
    // __proto__ vb. yasak; questionId quiz'e ait olmalı
    if (qid === '__proto__' || qid === 'prototype' || qid === 'constructor') continue;
    if (validQuestionIds.size && !validQuestionIds.has(qid)) continue;
    const maxPoints = pointsByQ[qid] != null ? pointsByQ[qid] : 1;
    let n = Number(g.manualScore);
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(n, maxPoints));
    const note = String(g.note == null ? '' : g.note).slice(0, 2000);
    grading[qid] = { manualScore: n, note };
  }
  // Object.create(null) -> normal obj
  const normGrading = Object.assign({}, grading);
  ref.assign({ grading: normGrading, status: 'graded', gradedAt: Date.now() }).write();
  recomputeResults(result.sessionId);
  res.json(ref.value());
});

// Öğrenci profili — tüm oturumları ve sonuçları
app.get('/api/admin/students/:stuId', adminOnly, (req, res) => {
  const r = resolveStudent(req.params.stuId);
  if (!r) return res.status(400).json({ error: 'Geçersiz öğrenci kimliği' });

  const sessions = db.get('sessions').value();
  const quizzes = db.get('quizzes').value();
  const allResults = db.get('results').value();

  let matched;
  let displayName, displaySinif, displayId;

  if (r.student) {
    // Yeni model: kayıtlı öğrenci, results boş olsa bile profili göster
    displayName = r.student.name;
    displaySinif = r.student.sinif;
    displayId = r.student.id;
    matched = allResults.filter(x => x.studentId === r.student.id ||
      (matchStudent(x, normalize(r.student.name), normalize(r.student.sinif))));
  } else {
    // Eski (base64) — name+sinif'tan results türet, results yoksa bulunamadı
    const name = normalize(r.name);
    const sinif = normalize(r.sinif);
    matched = allResults.filter(x => matchStudent(x, name, sinif));
    if (!matched.length) return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    const display = matched.find(x => x.name) || matched[0];
    displayName = display.name;
    displaySinif = display.sinif;
    displayId = req.params.stuId;
  }

  const enriched = matched.map(x => {
    const session = sessions.find(s => s.id === x.sessionId);
    const quiz = quizzes.find(q => q.id === session?.quizId);
    return {
      resultId: x.id,
      sessionId: x.sessionId,
      sessionCode: session?.code,
      quizTitle: quiz?.title || '(silinmiş quiz)',
      score: x.totalScore || 0,
      status: x.status,
      submittedAt: x.submittedAt,
      sessionEndedAt: session?.endedAt
    };
  }).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  const totalScore = enriched.reduce((acc, s) => acc + (s.score || 0), 0);

  res.json({
    student: {
      stuId: displayId,
      name: displayName,
      sinif: displaySinif,
      totalScore,
      quizCount: enriched.length
    },
    sessions: enriched
  });
});

// Öğrencinin belirli bir oturumdaki cevapları — stuId numara veya base64
app.get('/api/admin/students/:stuId/session/:sid', adminOnly, (req, res) => {
  const r = resolveStudent(req.params.stuId);
  if (!r) return res.status(400).json({ error: 'geçersiz id' });
  const name = (r.name || '').toLowerCase().trim();
  const sinif = (r.sinif || '').toLowerCase().trim();

  // Önce studentId match dene
  let result = null;
  if (r.student?.id) {
    result = db.get('results').find(x => x.sessionId === req.params.sid && x.studentId === r.student.id).value();
  }
  if (!result) {
    result = db.get('results').find(x =>
      x.sessionId === req.params.sid && matchStudent(x, name, sinif)
    ).value();
  }
  if (!result) return res.status(404).json({ error: 'sonuç yok' });

  const session = db.get('sessions').find({ id: result.sessionId }).value();
  const quiz = db.get('quizzes').find({ id: session?.quizId }).value();
  res.json({ result, quiz, session });
});

// === ÖĞRENCİ CRUD ===
// Tüm öğrenciler (admin liste)
app.get('/api/admin/students-list', adminOnly, (req, res) => {
  const students = db.get('students').value();
  const results = db.get('results').value();
  const enriched = students.map(s => {
    const sResults = results.filter(r => r.studentId === s.id);
    const totalScore = sResults.reduce((a, r) => a + (r.totalScore || 0), 0);
    return {
      id: s.id, name: s.name, sinif: s.sinif,
      createdAt: s.createdAt, createdBy: s.createdBy,
      quizCount: sResults.length, totalScore
    };
  }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));
  res.json(enriched);
});

// Manuel öğrenci ekleme
app.post('/api/admin/students', adminOnly, (req, res) => {
  const { name, sinif, id } = req.body || {};
  const vErr = validateNameSinif(name, sinif);
  if (vErr) return res.status(400).json({ error: vErr });
  const allIds = db.get('students').value().map(s => s.id);
  let newId = id?.toString().trim();
  if (newId) {
    if (!/^\d{6}$/.test(newId)) return res.status(400).json({ error: 'Numara 6 hane olmalı' });
    if (allIds.includes(newId)) return res.status(409).json({ error: 'Bu numara zaten kullanılıyor' });
  } else {
    newId = genStudentNumber(allIds);
  }
  const stu = {
    id: newId,
    name: name.trim(),
    sinif: (sinif || '').trim(),
    createdAt: Date.now(),
    createdBy: 'manual'
  };
  db.get('students').push(stu).write();
  logEvent('info', 'admin',
    `Öğretmen, "${stu.name}" adında yeni öğrenci ekledi (numara: ${stu.id}, sınıf: ${stu.sinif || '-'})`,
    { studentId: stu.id }
  );
  res.json(stu);
});

// Öğrenci silme (sonuçları da silinir — kaskad)
app.delete('/api/admin/students/:id', adminOnly, (req, res) => {
  const stu = db.get('students').find({ id: req.params.id }).value();
  if (!stu) return res.status(404).json({ error: 'Öğrenci bulunamadı' });
  const resultsCount = db.get('results').filter({ studentId: req.params.id }).size().value();
  db.get('results').remove({ studentId: req.params.id }).write();
  db.get('students').remove({ id: req.params.id }).write();
  logEvent('warn', 'admin',
    `Öğretmen, "${stu.name}" öğrencisini sildi. ${resultsCount} quiz sonucu da silindi`,
    { studentId: stu.id, deletedResults: resultsCount }
  );
  res.json({ ok: true, deletedResults: resultsCount });
});

// Sonuç silme (öğrenciye o sınava tekrar girme izni)
app.delete('/api/admin/results/:id', adminOnly, (req, res) => {
  const result = db.get('results').find({ id: req.params.id }).value();
  if (!result) return res.status(404).json({ error: 'Sonuç bulunamadı' });
  const session = db.get('sessions').find({ id: result.sessionId }).value();
  const quiz = db.get('quizzes').find({ id: session?.quizId }).value();
  db.get('results').remove({ id: req.params.id }).write();
  logEvent('info', 'admin',
    `Öğretmen, "${result.name}" öğrencisinin "${quiz?.title || 'silinmiş quiz'}" sonucunu sildi (öğrenci tekrar girebilir)`,
    { resultId: result.id, sessionId: result.sessionId, studentId: result.studentId }
  );
  res.json({ ok: true });
});

// === LOG endpoint'leri ===
app.get('/api/admin/logs', adminOnly, (req, res) => {
  const logs = db.get('logs').value() || [];
  const filtered = logs.slice().reverse(); // en yeni üstte
  res.json({ logs: filtered.slice(0, 200), total: logs.length });
});

app.delete('/api/admin/logs', adminOnly, (req, res) => {
  db.set('logs', []).write();
  res.json({ ok: true });
});

// Client-side hata logu (öğrenci sayfasından da gelebilir)
// Bulgu 2: level/source whitelist; ham string injection olmasın
// Bulgu 3: rate limit
const ALLOWED_LOG_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const ALLOWED_LOG_SOURCES = new Set(['client', 'student', 'admin', 'server']);
function safeShortStr(s, max) {
  return String(s == null ? '' : s).slice(0, max).replace(/[\x00-\x1f\x7f]/g, '');
}
app.post('/api/log', logLimiter, (req, res) => {
  const body = req.body || {};
  const lvl = ALLOWED_LOG_LEVELS.has(body.level) ? body.level : 'error';
  const src = ALLOWED_LOG_SOURCES.has(body.source) ? body.source : 'client';
  const message = safeShortStr(body.message, 500);

  // Context'i de güvenli string'lerle sınırla — depth=1
  const rawCtx = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : {};
  const ctx = {};
  let count = 0;
  for (const k of Object.keys(rawCtx)) {
    if (count >= 20) break;
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    const key = safeShortStr(k, 40);
    const v = rawCtx[k];
    if (v == null) ctx[key] = null;
    else if (typeof v === 'string') ctx[key] = safeShortStr(v, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') ctx[key] = v;
    else ctx[key] = safeShortStr(JSON.stringify(v), 500);
    count++;
  }
  ctx.ip = (req.ip || '').replace(/^::ffff:/, '');
  ctx.ua = safeShortStr(req.get('user-agent'), 200);
  logEvent(lvl, src, message || 'unknown', ctx);
  res.json({ ok: true });
});

// CSV export
// Bulgu 5: registration veya silinmiş quiz → 400/410
// Bulgu 8: Excel formula injection koruması
function csvSafeCell(v) {
  let s = String(v == null ? '' : v);
  // =+-@ ile başlayan hücreleri tek tırnakla başlat (Excel formula injection koruması)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // CRLF normalize
  s = s.replace(/\r?\n/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
}
app.get('/api/admin/sessions/:id/csv', adminOnly, (req, res) => {
  const session = db.get('sessions').find({ id: req.params.id }).value();
  if (!session) return res.status(404).json({ error: 'oturum yok' });
  if (session.kind === 'registration' || !session.quizId) {
    return res.status(400).json({ error: 'Bu kayıt oturumudur; CSV dışa aktarımı sadece quiz oturumları içindir.' });
  }
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  if (!quiz) return res.status(410).json({ error: 'Quiz silinmiş, CSV oluşturulamıyor.' });
  const results = db.get('results').filter({ sessionId: session.id }).value();

  const headers = ['Ad Soyad', 'Sınıf', 'Puan', 'Durum', 'Bitiş', ...quiz.questions.map((q, i) => `S${i + 1}`)];
  const rows = results.map(r => {
    const ts = r.submittedAt ? new Date(r.submittedAt).toLocaleString('tr-TR') : '';
    const cells = quiz.questions.map(q => {
      const a = (r.answers || []).find(x => x.questionId === q.id);
      return a ? String(a.value ?? '') : '';
    });
    return [r.name, r.sinif || '', r.totalScore || 0, r.status, ts, ...cells];
  });
  const csv = [headers, ...rows]
    .map(row => row.map(csvSafeCell).join(','))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="quiz-${session.code}.csv"`);
  res.send('﻿' + csv);
});

// ====================================================================
//  STUDENT API (LAN'dan erişilebilir)
// ====================================================================

app.get('/api/student/active', activeLimiter, (req, res) => {
  const session = db.get('sessions').find({ status: 'live' }).value();
  if (!session) return res.json({ active: false });
  const quiz = session.quizId ? db.get('quizzes').find({ id: session.quizId }).value() : null;
  res.json({
    active: true,
    code: session.code,
    kind: session.kind || 'quiz',
    acceptNewRegistrations: session.kind === 'registration' ? true : !!session.acceptNewRegistrations,
    title: quiz?.title || (session.kind === 'registration' ? 'Yeni Kayıt' : 'Quiz'),
    questionCount: quiz?.questions.length || 0,
    timeMode: quiz?.timeMode,
    timeValue: quiz?.timeValue
  });
});

// İsim/sınıf validasyonu — Bulgu 8
function validateNameSinif(name, sinif) {
  if (!name || typeof name !== 'string') return 'Ad Soyad gerekli';
  const n = name.trim();
  if (!n) return 'Ad Soyad gerekli';
  if (n.length < 2) return 'Ad Soyad çok kısa (en az 2 karakter)';
  if (n.length > 60) return 'Ad Soyad çok uzun (en fazla 60 karakter)';
  // Kontrol karakteri / null byte / yeni satır
  if (/[\x00-\x1f\x7f]/.test(n)) return 'Ad Soyad geçersiz karakter içeriyor';
  // HTML tag / XSS payload karakterleri — normal isimde olmaz, defense in depth
  if (/[<>]/.test(n)) return 'Ad Soyad geçersiz karakter içeriyor (< > kullanılamaz)';
  const s = (sinif == null ? '' : String(sinif)).trim();
  if (s.length > 20) return 'Sınıf çok uzun (en fazla 20 karakter)';
  if (s && /[\x00-\x1f\x7f]/.test(s)) return 'Sınıf geçersiz karakter içeriyor';
  if (s && /[<>]/.test(s)) return 'Sınıf geçersiz karakter içeriyor';
  return null;
}

// === KAYIT (registration) — yeni öğrenci numarası verir ===
app.post('/api/student/register', registerLimiter, (req, res) => {
  const { code, name, sinif } = req.body || {};
  const session = db.get('sessions').find({ code, status: 'live' }).value();
  if (!session) return res.status(404).json({ error: 'Kod bulunamadı veya oturum kapandı' });
  const vErr = validateNameSinif(name, sinif);
  if (vErr) return res.status(400).json({ error: vErr });

  // Hibrit toggle: quiz oturumunda da kayıt mümkün mü?
  const allowReg = session.kind === 'registration' || session.acceptNewRegistrations;
  if (!allowReg) return res.status(403).json({ error: 'Bu oturum yeni kayıt kabul etmiyor. Numaranı kullan veya öğretmenine sor.' });

  // Aynı isim+sınıf zaten kayıtlı mı? (Türkçe-aware normalize ile)
  const nName = normalize(name);
  const nSinif = normalize(sinif);
  const existing = db.get('students').find(s =>
    normalize(s.name) === nName && normalize(s.sinif) === nSinif
  ).value();
  if (existing) {
    logEvent('info', 'student',
      `"${existing.name}" zaten kayıtlı. Mevcut numarası tekrar verildi: ${existing.id}`,
      { studentId: existing.id, sinif: existing.sinif, sessionCode: session.code }
    );
    return res.json({
      studentId: existing.id,
      name: existing.name,
      sinif: existing.sinif,
      alreadyRegistered: true
    });
  }

  const allIds = db.get('students').value().map(s => s.id);
  let newId;
  try { newId = genStudentNumber(allIds); }
  catch (e) {
    logEvent('error', 'student', 'Yeni öğrenci numarası üretilemedi (çakışma)', { error: e.message });
    return res.status(500).json({ error: 'Numara üretilemedi, tekrar dene' });
  }
  const stu = {
    id: newId,
    name: name.trim(),
    sinif: (sinif || '').trim(),
    createdAt: Date.now(),
    createdBy: session.kind === 'registration' ? 'registration' : 'inline'
  };
  db.get('students').push(stu).write();
  logEvent('info', 'student',
    `"${stu.name}" yeni kayıt oldu, numara ${stu.id} verildi (sınıf: ${stu.sinif || '-'})`,
    { studentId: stu.id, sessionId: session.id, sessionKind: session.kind, sessionCode: session.code }
  );

  io.to('admin').emit('student:registered', { studentId: stu.id, name: stu.name, sinif: stu.sinif });

  res.json({
    studentId: stu.id,
    name: stu.name,
    sinif: stu.sinif,
    alreadyRegistered: false
  });
});

// === GİRİŞ (numara veya isim+sınıf ile) — quiz'e tek girişlik bağlanma ===
app.post('/api/student/login', loginLimiter, (req, res) => {
  const { code, studentId, name, sinif } = req.body || {};
  const session = db.get('sessions').find({ code, status: 'live' }).value();
  if (!session) return res.status(404).json({ error: 'Quiz kodu bulunamadı veya oturum kapandı' });
  if (session.kind !== 'quiz') {
    return res.status(400).json({ error: 'Bu bir quiz oturumu değil. Kayıt için "Yeni kayıt" sekmesini kullan.' });
  }

  // Öğrenci kaydını bul: önce numara, sonra isim+sınıf
  let stu = null;
  if (studentId) {
    stu = db.get('students').find({ id: String(studentId).trim() }).value();
    if (!stu) {
      logEvent('warn', 'student',
        `Bilinmeyen numara ile giriş denemesi: "${studentId}" (quiz kodu: ${code})`,
        { code, attemptedId: studentId }
      );
      return res.status(404).json({ error: 'Bu numara kayıtlı değil. "Yeni kayıt" sekmesini dene veya öğretmenine sor.' });
    }
  } else if (name?.trim()) {
    const vErr = validateNameSinif(name, sinif);
    if (vErr) return res.status(400).json({ error: vErr });
    const nName = normalize(name);
    const nSinif = normalize(sinif || '');
    stu = db.get('students').find(s => normalize(s.name) === nName && normalize(s.sinif) === nSinif).value();
    if (!stu) {
      logEvent('warn', 'student',
        `İsim+sınıf ile giriş başarısız: "${name}" / "${sinif || ''}" eşleşen kayıt yok (quiz kodu: ${code})`,
        { code, attemptedName: name, attemptedSinif: sinif }
      );
      return res.status(404).json({ error: 'Bu isim ve sınıfla eşleşen öğrenci kaydı yok. Numaranı kullan veya yeni kayıt yap.' });
    }
  } else {
    return res.status(400).json({ error: 'Numara veya Ad Soyad gerekli' });
  }

  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  if (!quiz) return res.status(500).json({ error: 'Quiz veritabanında bulunamadı (silinmiş olabilir)' });

  // Duplicate guard: bu öğrencinin bu oturumda mevcut sonucu var mı?
  const existing = db.get('results').find(r => r.sessionId === session.id && r.studentId === stu.id).value();

  if (existing && existing.status !== 'in_progress') {
    logEvent('warn', 'student',
      `"${stu.name}" "${quiz.title}" sınavına tekrar girmeye çalıştı (zaten teslim etmiş)`,
      { studentId: stu.id, sessionId: session.id, sessionCode: code, previousStatus: existing.status }
    );
    return res.status(409).json({
      error: 'Bu sınava daha önce girdin ve teslim ettin. Tekrar girmek istiyorsan öğretmenin önceki sonucunu silmeli.',
      alreadyTaken: true
    });
  }

  let result;
  if (existing) {
    result = existing;
    logEvent('info', 'student',
      `"${stu.name}" yarım kalan "${quiz.title}" sınavına devam ediyor`,
      { studentId: stu.id, sessionId: session.id }
    );
  } else {
    const sanitized = sanitizeQuizForStudent(quiz);
    result = {
      id: nanoid(10),
      sessionId: session.id,
      studentId: stu.id,
      name: stu.name,
      sinif: stu.sinif || '',
      answers: [],
      status: 'in_progress',
      joinedAt: Date.now(),
      submittedAt: null,
      questionOrder: sanitized.questions.map(q => q.id),
      mcOptionOrder: Object.fromEntries(
        sanitized.questions.filter(q => q.type === 'multiple_choice').map(q => [q.id, q.options.map(o => o.idx)])
      ),
      totalScore: 0
    };
    db.get('results').push(result).write();
    logEvent('info', 'student',
      `"${stu.name}" (${stu.id}) "${quiz.title}" sınavına girdi`,
      { studentId: stu.id, sessionId: session.id, sessionCode: code, sinif: stu.sinif }
    );
  }

  const studentQuiz = buildStudentQuiz(quiz, result);
  // Bulgu 20: sadece admin namespace'ine emit
  io.to('admin').emit('student:joined', { sessionId: session.id, name: result.name, sinif: result.sinif, studentId: stu.id });

  // Bulgu 1: oturum tokenı üret + HttpOnly cookie ile gönder
  const accessToken = issueStudentToken(result.id, stu.id);
  res.cookie?.(STUDENT_TOKEN_COOKIE, accessToken, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: STUDENT_TOKEN_TTL_MS
  });
  // express'in res.cookie zaten var; emin olmak için manuel Set-Cookie da yazıyoruz
  res.setHeader('Set-Cookie',
    `${STUDENT_TOKEN_COOKIE}=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(STUDENT_TOKEN_TTL_MS / 1000)}`
  );

  // Bulgu 14: öğrenciye orijinal idx sızdırma — pozisyon bazlı dön
  const safeQuiz = stripOriginalIdxFromQuiz(studentQuiz);

  res.json({
    participantId: result.id,
    sessionId: session.id,
    studentId: stu.id,
    accessToken, // header üzerinden de gönderebilsin diye
    name: stu.name,
    sinif: stu.sinif,
    quiz: safeQuiz,
    answers: result.answers
  });
});

// Bulgu 14: öğrenciye orijinal mc option index'lerini gizle — sadece pozisyon (0..n)
function stripOriginalIdxFromQuiz(studentQuiz) {
  if (!studentQuiz || !Array.isArray(studentQuiz.questions)) return studentQuiz;
  return {
    ...studentQuiz,
    questions: studentQuiz.questions.map(q => {
      if (q.type !== 'multiple_choice' || !Array.isArray(q.options)) return q;
      return {
        ...q,
        options: q.options.map((o, pos) => ({ pos, text: typeof o === 'object' ? o.text : String(o) }))
      };
    })
  };
}

// === Eski join endpoint (backward compat, ad-soyad ile join) — hibrit modda kayıt+giriş yapar ===
// Bulgu 11: Quiz oturumlarında çift auth surface'i kapat. Sadece registration session'da
// veya LEGACY_JOIN=1 env değişkeniyle aktif olsun.
app.post('/api/student/join', registerLimiter, async (req, res) => {
  // Yeni model: önce register (eğer kayıtlı değilse), sonra login.
  const { code, name, sinif } = req.body || {};
  const vErr = validateNameSinif(name, sinif);
  if (vErr) return res.status(400).json({ error: vErr });
  const session = db.get('sessions').find({ code, status: 'live' }).value();
  if (!session) return res.status(404).json({ error: 'Kod bulunamadı veya quiz kapandı' });
  // Quiz oturumlarında bu endpoint kapalı — login/register kullan
  if (session.kind === 'quiz' && process.env.LEGACY_JOIN !== '1') {
    return res.status(410).json({ error: 'Bu endpoint kullanım dışı. /api/student/login veya /api/student/register kullan.' });
  }

  // Aynı isim+sınıf zaten kayıtlı mı?
  let stu = db.get('students').find(s =>
    (s.name || '').toLowerCase().trim() === name.trim().toLowerCase() &&
    (s.sinif || '').toLowerCase().trim() === (sinif || '').trim().toLowerCase()
  ).value();

  if (!stu) {
    if (!session.acceptNewRegistrations && session.kind === 'quiz') {
      return res.status(403).json({ error: 'Bu oturum yeni kayıt kabul etmiyor. Numaranı kullan veya öğretmenine sor.' });
    }
    const allIds = db.get('students').value().map(s => s.id);
    const newId = genStudentNumber(allIds);
    stu = {
      id: newId, name: name.trim(), sinif: (sinif || '').trim(),
      createdAt: Date.now(), createdBy: 'inline'
    };
    db.get('students').push(stu).write();
    logEvent('info', 'student', `Inline yeni kayıt: ${stu.name} (${stu.id})`, { studentId: stu.id, sessionId: session.id });
    io.to('admin').emit('student:registered', { studentId: stu.id, name: stu.name, sinif: stu.sinif });
  }

  // login akışını manuel tekrarla
  if (session.kind !== 'quiz') {
    return res.json({ studentId: stu.id, name: stu.name, sinif: stu.sinif, registrationOnly: true });
  }
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  if (!quiz) return res.status(500).json({ error: 'quiz bulunamadı' });

  const existing = db.get('results').find(r => r.sessionId === session.id && r.studentId === stu.id).value();
  if (existing && existing.status !== 'in_progress') {
    return res.status(409).json({
      error: 'Bu sınava daha önce girdin ve teslim ettin. Tekrar girmek istiyorsan öğretmenine bildir.',
      alreadyTaken: true
    });
  }
  let result = existing;
  if (!result) {
    const sanitized = sanitizeQuizForStudent(quiz);
    result = {
      id: nanoid(10), sessionId: session.id, studentId: stu.id,
      name: stu.name, sinif: stu.sinif || '',
      answers: [], status: 'in_progress',
      joinedAt: Date.now(), submittedAt: null,
      questionOrder: sanitized.questions.map(q => q.id),
      mcOptionOrder: Object.fromEntries(
        sanitized.questions.filter(q => q.type === 'multiple_choice').map(q => [q.id, q.options.map(o => o.idx)])
      ),
      totalScore: 0
    };
    db.get('results').push(result).write();
  }
  const studentQuiz = buildStudentQuiz(quiz, result);
  io.to('admin').emit('student:joined', { sessionId: session.id, name: result.name, sinif: result.sinif });
  // Bulgu 1: legacy join'den de token gönder (eğer hâlâ enable ise)
  const accessToken = issueStudentToken(result.id, stu.id);
  res.setHeader('Set-Cookie',
    `${STUDENT_TOKEN_COOKIE}=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(STUDENT_TOKEN_TTL_MS / 1000)}`
  );
  res.json({
    participantId: result.id, sessionId: session.id, studentId: stu.id,
    accessToken,
    name: stu.name, sinif: stu.sinif,
    quiz: stripOriginalIdxFromQuiz(studentQuiz), answers: result.answers
  });
});

function buildStudentQuiz(quiz, result) {
  const orderedQuestions = result.questionOrder.map(qid => {
    const q = quiz.questions.find(x => x.id === qid);
    if (!q) return null;
    const base = { id: q.id, type: q.type, text: q.text, points: q.points || 1 };
    if (q.image) base.image = q.image;
    if (q.type === 'multiple_choice') {
      const orderIdx = result.mcOptionOrder?.[q.id] || q.options.map((_, i) => i);
      base.options = orderIdx.map(originalIdx => ({
        idx: originalIdx,
        text: q.options[originalIdx],
        image: q.optionImages?.[originalIdx] || null
      }));
    }
    return base;
  }).filter(Boolean);

  return {
    title: quiz.title,
    timeMode: quiz.timeMode,
    timeValue: quiz.timeValue,
    questions: orderedQuestions
  };
}

// Bulgu 1: öğrenci endpoint'lerine token auth
function requireStudentAuth(req, res, resultId) {
  if (!validateStudentToken(req, resultId)) {
    res.status(403).json({ error: 'Bu sınava erişim izniniz yok. Lütfen tekrar giriş yapın.' });
    return false;
  }
  return true;
}

// Bulgu 10: öğrenciye dönen result'taki cevap anahtarı sızıntısını temizle
function sanitizeResultForStudent(result) {
  if (!result) return result;
  const safe = { ...result };
  if (Array.isArray(safe.answers)) {
    safe.answers = safe.answers.map(a => ({
      questionId: a.questionId,
      value: a.value,
      answeredAt: a.answeredAt
    }));
  }
  delete safe.grading;
  delete safe.mcOptionOrder; // sunucu işi
  return safe;
}

// Öğrenci cevap kaydet (auto-save, her soru için)
app.post('/api/student/answer', answerLimiter, (req, res) => {
  const { resultId, questionId, value } = req.body || {};
  if (typeof resultId !== 'string' || typeof questionId !== 'string') {
    return res.status(400).json({ error: 'geçersiz parametre' });
  }
  // Cevap boyutu 10KB ile sınırlı
  if (typeof value === 'string' && value.length > 10000) {
    return res.status(413).json({ error: 'cevap çok uzun' });
  }
  if (!requireStudentAuth(req, res, resultId)) return;

  const ref = db.get('results').find({ id: resultId });
  const result = ref.value();
  if (!result) return res.status(404).json({ error: 'kayıt yok' });
  if (result.status !== 'in_progress') return res.status(400).json({ error: 'quiz bitti' });

  // Bulgu 5: quiz silinmişse 410
  const session = db.get('sessions').find({ id: result.sessionId }).value();
  if (!session || session.status !== 'live') return res.status(410).json({ error: 'oturum kapandı' });
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  if (!quiz) return res.status(410).json({ error: 'quiz silinmiş' });

  // Bulgu 14: gelen value mc için pozisyon olabilir → orijinal index'e çevir
  const q = quiz.questions.find(x => x.id === questionId);
  if (!q) return res.status(400).json({ error: 'geçersiz soru' });
  let storedValue = value;
  if (q.type === 'multiple_choice') {
    const order = result.mcOptionOrder?.[questionId] || q.options.map((_, i) => i);
    const pos = Number(value);
    if (Number.isFinite(pos) && pos >= 0 && pos < order.length) {
      storedValue = order[pos];
    } else if (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) < q.options.length) {
      // Geri uyumluluk: eğer doğrudan orijinal index gönderilmişse de kabul (eski client)
      storedValue = Number(value);
    } else {
      return res.status(400).json({ error: 'geçersiz cevap' });
    }
  } else if (q.type === 'true_false') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') {
      return res.status(400).json({ error: 'geçersiz cevap' });
    }
    storedValue = (value === true || value === 'true');
  } else if (q.type === 'open_ended') {
    storedValue = String(value == null ? '' : value).slice(0, 10000);
  }

  const answers = result.answers.filter(a => a.questionId !== questionId);
  answers.push({ questionId, value: storedValue, answeredAt: Date.now() });
  ref.assign({ answers }).write();
  res.json({ ok: true });
});

// Öğrenci teslim et
app.post('/api/student/submit', (req, res) => {
  const { resultId } = req.body || {};
  if (typeof resultId !== 'string') return res.status(400).json({ error: 'geçersiz parametre' });
  if (!requireStudentAuth(req, res, resultId)) return;

  const ref = db.get('results').find({ id: resultId });
  const result = ref.value();
  if (!result) return res.status(404).json({ error: 'kayıt yok' });
  if (result.status !== 'in_progress') {
    return res.json({ ok: true, alreadySubmitted: true });
  }

  const session = db.get('sessions').find({ id: result.sessionId }).value();
  if (!session) return res.status(410).json({ error: 'oturum bulunamadı' });
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  // Bulgu 5: quiz silinmişse crash etme — sadece submit edilmiş olarak işaretle
  if (!quiz) {
    ref.assign({
      status: 'submitted',
      submittedAt: Date.now(),
      totalScore: 0
    }).write();
    revokeStudentTokensForResult(resultId);
    return res.status(410).json({ error: 'Quiz silinmiş, cevaplarınız kaydedildi ama değerlendirilemiyor.' });
  }

  // Otomatik puanlama (mc + tf)
  let hasOpen = false;
  const scoredAnswers = result.answers.map(a => {
    const q = quiz.questions.find(x => x.id === a.questionId);
    if (!q) return a;
    if (q.type === 'open_ended') hasOpen = true;
    const sc = autoScore(q, a.value);
    return { ...a, ...sc };
  });

  const total = scoredAnswers.reduce((acc, a) => acc + (a.autoScore || 0), 0);
  ref.assign({
    answers: scoredAnswers,
    status: hasOpen ? 'awaiting_grading' : 'submitted',
    submittedAt: Date.now(),
    totalScore: total
  }).write();

  // Bulgu 20: sadece admin'e gönder
  io.to('admin').emit('student:submitted', { sessionId: session.id, name: result.name, score: total });
  // Submit edildi → tokenı iptal et (yeniden submit/sabote etmeyi önler)
  revokeStudentTokensForResult(resultId);
  res.json({ ok: true, totalScore: total, awaitingGrading: hasOpen });
});

// Resume: bir kayıt durumunu çek
app.get('/api/student/result/:id', (req, res) => {
  if (!requireStudentAuth(req, res, req.params.id)) return;
  const result = db.get('results').find({ id: req.params.id }).value();
  if (!result) return res.status(404).json({ error: 'yok' });
  const session = db.get('sessions').find({ id: result.sessionId }).value();
  const safeResult = sanitizeResultForStudent(result);
  if (!session || session.status !== 'live') return res.json({ result: safeResult, sessionLive: false });
  const quiz = db.get('quizzes').find({ id: session.quizId }).value();
  if (!quiz) {
    // Bulgu 5: quiz silinmiş ama oturum açık — anlamlı 410 dön
    return res.status(410).json({ error: 'Quiz silinmiş' });
  }
  res.json({
    result: safeResult,
    quiz: stripOriginalIdxFromQuiz(buildStudentQuiz(quiz, result)),
    sessionLive: true
  });
});

// ====================================================================
//  Yardımcı
// ====================================================================
function recomputeResults(sessionId) {
  const session = db.get('sessions').find({ id: sessionId }).value();
  if (!session) return;
  const q = db.get('quizzes').find({ id: session.quizId }).value();
  db.get('results').filter({ sessionId }).each(r => {
    let total = 0;
    for (const a of (r.answers || [])) {
      const auto = a.autoScore || 0;
      const manual = r.grading?.[a.questionId]?.manualScore || 0;
      total += auto + manual;
    }
    r.totalScore = total;
    // hala açık uçlu var mı?
    const hasUngraded = (q?.questions || []).some(qq =>
      qq.type === 'open_ended' &&
      (r.answers || []).some(a => a.questionId === qq.id) &&
      !(r.grading || {})[qq.id]
    );
    if (r.status !== 'in_progress') {
      r.status = hasUngraded ? 'awaiting_grading' : 'graded';
    }
  }).write();
}

// Socket bağlantı durumu (admin için)
// Bulgu 20: admin socket'leri 'admin' room'una al; öğrencilere broadcast yapma
io.on('connection', socket => {
  // socket.io 4.x: socket.request available
  try {
    const sock = socket.request?.connection || socket.request?.socket;
    const ip = (sock?.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') socket.join('admin');
  } catch (e) {}
  socket.on('disconnect', () => {});
});

// ====================================================================
//  Global hata handler — Bulgu 4: stack trace sızdırma
// ====================================================================
// JSON parse hatası (express.json) gibi durumlar için
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // express-rate-limit zaten kendi response'unu yazıyor
  const status = err.status || err.statusCode || 500;
  // Loglamayı yap, kullanıcıya stack verme
  try {
    logEvent('error', 'server', err.message || 'unknown error', {
      url: req.originalUrl,
      method: req.method,
      stack: err.stack
    });
  } catch (e) {}
  if (status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Geçersiz JSON' });
  }
  if (status === 413) {
    return res.status(413).json({ error: 'İstek çok büyük' });
  }
  res.status(status === 500 ? 500 : status).json({ error: status >= 500 ? 'Sunucu hatası' : (err.message || 'hata') });
});

// 404 (sadece /api altında JSON; aksi halde statik dosya zaten serve edildi)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'bulunamadı' });
});

// ====================================================================
//  Başlat
// ====================================================================
server.listen(PORT, '0.0.0.0', async () => {
  const ips = getLocalIPs();
  console.log('\n==========================================');
  console.log('  QUIZ UYGULAMASI ÇALIŞIYOR');
  console.log('==========================================');
  console.log(`  Sen (öğretmen): http://localhost:${PORT}/`);
  console.log('  Öğrenciler (LAN):');
  for (const ip of ips) console.log(`     http://${ip.address}:${PORT}/`);
  console.log('==========================================\n');

  try {
    await open(`http://localhost:${PORT}/`);
  } catch (e) { /* sessiz geç */ }
});
