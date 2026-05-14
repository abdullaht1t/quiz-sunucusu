const os = require('os');

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

function pickPrimaryIP() {
  const ips = getLocalIPs();
  // 192.168.x.x veya 10.x.x.x öncelikli
  const local = ips.find(i => /^192\.168\./.test(i.address) || /^10\./.test(i.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(i.address));
  return local?.address || ips[0]?.address || '127.0.0.1';
}

function genSessionCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 6 haneli unique numara — verilen mevcut numaraları kontrol eder
function genStudentNumber(existingIds = []) {
  const set = new Set(existingIds.map(String));
  for (let i = 0; i < 1000; i++) {
    const n = Math.floor(100000 + Math.random() * 900000).toString();
    if (!set.has(n)) return n;
  }
  throw new Error('Numara üretilemedi (çakışma)');
}

// TCP socket'in gerçek remote address'i — X-Forwarded-For gibi header'lar spoof edilebilir.
// TCP el sıkışmasında kaynak IP doğrulandığı için socket.remoteAddress güvenilirdir.
function isLocalRequest(req) {
  const sock = req.socket || req.connection;
  const ip = (sock?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function normalize(str) {
  return (str || '')
    .toString()
    .toLocaleLowerCase('tr-TR')
    .trim()
    .replace(/\s+/g, ' ');
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Quizi öğrenciye servis ederken doğru cevapları temizle, gerekirse karıştır
function sanitizeQuizForStudent(quiz) {
  let questions = quiz.questions.map(q => {
    const base = {
      id: q.id,
      type: q.type,
      text: q.text,
      points: q.points || 1
    };
    if (q.image) base.image = q.image;
    if (q.type === 'multiple_choice') {
      let options = (q.options || []).map((opt, idx) => ({
        idx,
        text: opt,
        image: q.optionImages?.[idx] || null
      }));
      if (quiz.shuffleOptions) options = shuffleArray(options);
      base.options = options;
    }
    return base;
  });

  if (quiz.shuffleQuestions) questions = shuffleArray(questions);
  return { ...quiz, questions };
}

// Otomatik puanlama (mc + tf). open_ended manuel.
function autoScore(question, answer) {
  if (answer == null) return { autoScore: 0, isCorrect: false, gradable: 'auto' };
  switch (question.type) {
    case 'multiple_choice': {
      const correct = Number(answer) === Number(question.correctIndex);
      return { autoScore: correct ? (question.points || 1) : 0, isCorrect: correct, gradable: 'auto' };
    }
    case 'true_false': {
      const correct = String(answer) === String(question.correctBool);
      return { autoScore: correct ? (question.points || 1) : 0, isCorrect: correct, gradable: 'auto' };
    }
    case 'open_ended':
      return { autoScore: 0, isCorrect: null, gradable: 'manual' };
    default:
      return { autoScore: 0, isCorrect: false, gradable: 'auto' };
  }
}

module.exports = {
  getLocalIPs,
  pickPrimaryIP,
  genSessionCode,
  genStudentNumber,
  isLocalRequest,
  normalize,
  shuffleArray,
  sanitizeQuizForStudent,
  autoScore
};
