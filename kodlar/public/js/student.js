// ============================================================
//  Quiz - Öğrenci tarafı
// ============================================================
const app = document.getElementById('app');

const LS_KEY = 'quiz_active_result';
const LS_NUM = 'quiz_my_number';
const LS_NAME = 'quiz_last_name';
const LS_SINIF = 'quiz_last_sinif';

// ---------- Global hata yakalama (sadece beklenmedik) ----------
function reportError(message, context) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'error', source: 'student',
        message: String(message || 'bilinmeyen hata'),
        context: { url: location.href, ...(context || {}) }
      })
    }).catch(() => {});
  } catch (e) {}
}
// JS exception (TypeError, ReferenceError vb.) — gerçek bug demek
window.addEventListener('error', e => {
  // Source dosyamızda olmayan harici hataları skip et (extension vb.)
  if (!e.filename || e.filename.indexOf(location.origin) < 0) return;
  reportError('JavaScript hatası: ' + e.message,
    { filename: e.filename, line: e.lineno, stack: e.error?.stack?.slice(0, 500) });
});
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  // API hatalarını skip et — bunlar kullanıcıya zaten gösteriliyor
  if (reason?.silent || reason?.status >= 400 && reason?.status < 500) return;
  reportError('Yakalanmamış async hata: ' + (reason?.message || reason),
    { stack: reason?.stack?.slice(0, 500) });
});

// ---------- API ----------
// Bulgu 1: login sırasında alınan accessToken'ı sonraki isteklerde gönder
let _accessToken = null;
try {
  const cached = localStorage.getItem('quiz_access_token');
  if (cached) _accessToken = cached;
} catch (e) {}
function setAccessToken(t) {
  _accessToken = t;
  try { if (t) localStorage.setItem('quiz_access_token', t); }
  catch (e) {}
}
function clearAccessToken() {
  _accessToken = null;
  try { localStorage.removeItem('quiz_access_token'); } catch (e) {}
}
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (_accessToken) headers['X-Student-Token'] = _accessToken;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let payload = null;
    try { payload = await res.json(); msg = payload.error || msg; } catch (e) {}
    const err = new Error(msg);
    err.payload = payload;
    err.status = res.status;
    err.silent = true; // beklenen API hatası — global error reporter atla
    throw err;
  }
  return res.json();
}

function tplClone(id) {
  const t = document.getElementById(id);
  if (!t) return document.createDocumentFragment();
  return t.content.cloneNode(true);
}

function showToast(message, type = 'good', durationMs = 2500) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'toast ' + type;
  div.textContent = message;
  host.appendChild(div);
  setTimeout(() => {
    div.classList.add('leaving');
    setTimeout(() => div.remove(), 220);
  }, durationMs);
}

// ---------- OTP input bağlayıcı ----------
function bindOtp(container, onComplete) {
  const inputs = [...container.querySelectorAll('input')];
  function getValue() { return inputs.map(x => x.value).join(''); }
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
      const val = getValue();
      if (val.length === 6 && onComplete) onComplete(val);
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
    });
    inp.addEventListener('paste', e => {
      const text = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!text) return;
      e.preventDefault();
      [...text].forEach((c, k) => { if (inputs[k]) inputs[k].value = c; });
      inputs[Math.min(text.length, inputs.length - 1)].focus();
      if (text.length === 6 && onComplete) onComplete(text);
    });
  });
  return getValue;
}

// ============================================================
//  Açılış akışı — tek poll interval'i, sayfa sallanması olmaz
// ============================================================
let pollInterval = null;
let currentScreen = null; // 'noactive' | 'reg' | 'wait' | 'join' | 'quiz' | 'done' | 'taken'

function stopPoll() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}
function startPoll(fn, ms = 5000) {
  stopPoll();
  pollInterval = setInterval(fn, ms);
}

async function start() {
  stopPoll();

  // Devam eden bir quiz var mı?
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try {
      const { resultId } = JSON.parse(saved);
      const r = await api(`/api/student/result/${resultId}`);
      if (r.sessionLive && r.result.status === 'in_progress') {
        return enterQuiz({
          participantId: r.result.id,
          quiz: r.quiz,
          answers: r.result.answers
        });
      }
    } catch (e) {
      localStorage.removeItem(LS_KEY);
    }
  }

  await checkAndRoute();
}

// Aktif oturuma göre route et — sayfa tekrar render etmeyi minimize et
async function checkAndRoute() {
  let active;
  try { active = await api('/api/student/active'); }
  catch (e) { active = { active: false }; }

  if (!active.active) {
    if (currentScreen !== 'noactive' && currentScreen !== 'wait') {
      renderNoActive();
    } else if (currentScreen === 'wait') {
      // bekleme ekranındayız ve oturum kapandı → noactive'e geç
      renderNoActive();
    }
    // 5sn polling: oturum açılır ise otomatik yenilen
    startPoll(checkAndRoute, 5000);
    return;
  }

  // Kayıt oturumu açıksa, kullanıcı zaten kaydolmuşsa bekleme ekranı; değilse kayıt formu
  if (active.kind === 'registration') {
    const myNum = localStorage.getItem(LS_NUM);
    if (myNum && /^\d{6}$/.test(myNum) && currentScreen === 'wait') {
      // zaten bekleme ekranındayız, polling devam etsin
      startPoll(checkAndRoute, 5000);
      return;
    }
    if (currentScreen !== 'reg') {
      renderRegOnly(active);
    }
    // Kayıt ekranındayken polling YAPMA (kullanıcı form dolduruyor olabilir)
    return;
  }

  // Quiz oturumu açıldı
  if (active.kind === 'quiz') {
    // Eğer bekleme ekranındaydık ve numaramız varsa otomatik login dene
    const myNum = localStorage.getItem(LS_NUM);
    if (currentScreen === 'wait' && myNum && /^\d{6}$/.test(myNum)) {
      try {
        const data = await api('/api/student/login', {
          method: 'POST',
          body: { code: active.code, studentId: myNum }
        });
        if (data.accessToken) setAccessToken(data.accessToken);
        localStorage.setItem(LS_KEY, JSON.stringify({ resultId: data.participantId, sessionId: data.sessionId }));
        return enterQuiz(data);
      } catch (e) {
        // Otomatik login başarısız (zaten girmiş vs.) → join ekranı
        if (e.payload?.alreadyTaken) { renderAlreadyTaken(); return; }
        renderJoin(active);
        return;
      }
    }
    if (currentScreen !== 'join') {
      renderJoin(active);
    }
  }
}

function renderNoActive() {
  currentScreen = 'noactive';
  stopPoll();
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-no-active'));
  startPoll(checkAndRoute, 5000);
}

function renderWaitForQuiz() {
  currentScreen = 'wait';
  stopPoll();
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-wait-quiz'));
  const num = localStorage.getItem(LS_NUM) || '------';
  document.getElementById('myStoredNum').textContent = num;
  // Polling: quiz oturumu açılırsa otomatik geçiş
  startPoll(checkAndRoute, 4000);
}

// ============================================================
//  Sadece kayıt oturumu (registration session)
// ============================================================
function renderRegOnly(active) {
  currentScreen = 'reg';
  stopPoll(); // form dolarken polling istemiyoruz
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-reg-only'));

  const lastName = localStorage.getItem(LS_NAME);
  const lastSinif = localStorage.getItem(LS_SINIF);
  if (lastName) document.getElementById('rfName').value = lastName;
  if (lastSinif) document.getElementById('rfSinif').value = lastSinif;

  const err = document.getElementById('regError');
  document.getElementById('regOnlyBtn').onclick = async () => {
    const name = document.getElementById('rfName').value.trim();
    const sinif = document.getElementById('rfSinif').value.trim();
    err.classList.add('hidden');
    if (!name) { err.textContent = 'Ad Soyad gerekli'; err.classList.remove('hidden'); return; }
    try {
      const r = await api('/api/student/register', {
        method: 'POST',
        body: { code: active.code, name, sinif }
      });
      localStorage.setItem(LS_NAME, name);
      localStorage.setItem(LS_SINIF, sinif);
      localStorage.setItem(LS_NUM, r.studentId);
      renderRegDone(r, /*comingFromQuiz*/ false);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
}

// ============================================================
//  Kayıt sonrası — büyük numara ekranı
// ============================================================
function renderRegDone(reg, comingFromQuiz) {
  currentScreen = 'regdone';
  stopPoll();
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-reg-done'));
  document.getElementById('rdName').textContent = reg.name;
  document.getElementById('rdNumber').textContent = reg.studentId;
  const btn = document.getElementById('continueBtn');
  if (comingFromQuiz) {
    btn.textContent = 'Quize başla →';
    btn.onclick = async () => {
      // Quiz oturumuna numarayla otomatik login
      try {
        const active = await api('/api/student/active');
        if (!active.active || active.kind !== 'quiz') {
          renderWaitForQuiz();
          return;
        }
        const data = await api('/api/student/login', {
          method: 'POST',
          body: { code: active.code, studentId: reg.studentId }
        });
        if (data.accessToken) setAccessToken(data.accessToken);
        localStorage.setItem(LS_KEY, JSON.stringify({ resultId: data.participantId, sessionId: data.sessionId }));
        enterQuiz(data);
      } catch (e) {
        if (e.payload?.alreadyTaken) { renderAlreadyTaken(); return; }
        showToast('Quize girilemedi: ' + e.message, 'bad');
        start();
      }
    };
  } else {
    // Kayıt oturumundan geldik — bekleme ekranına geç
    btn.onclick = () => renderWaitForQuiz();
  }
}

// ============================================================
//  Quiz join (iki sekme)
// ============================================================
function renderJoin(active) {
  currentScreen = 'join';
  stopPoll();
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-join'));

  document.getElementById('joinTitle').textContent = active.title || 'Quiz';

  // Hibrit kapalıysa "Yeni kayıt" sekmesini gizle
  const tabNew = document.getElementById('tabNew');
  if (!active.acceptNewRegistrations) {
    tabNew.classList.add('hidden');
    document.getElementById('joinTabs').classList.add('one-col');
    document.getElementById('haveHint').textContent = 'Bu sınav sadece kayıtlı öğrencilere açık. Numaran yoksa öğretmenine sor.';
  }

  // Tab switch
  const tabs = document.querySelectorAll('.seg-btn');
  const panels = document.querySelectorAll('.seg-panel');
  tabs.forEach(t => {
    t.onclick = () => {
      if (t.classList.contains('hidden')) return;
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
    };
  });

  // "Numaram var" panelinde iki mod: numara / isim+sınıf
  const havePanel = document.querySelector('[data-panel="have"]');
  const numMode = havePanel.querySelector('[data-mode="num"]');
  const nameMode = havePanel.querySelector('[data-mode="name"]');
  document.getElementById('forgotLink').onclick = (e) => {
    e.preventDefault();
    numMode.classList.add('hidden');
    nameMode.classList.remove('hidden');
    document.getElementById('loginName').focus();
  };
  document.getElementById('backToNumLink').onclick = (e) => {
    e.preventDefault();
    nameMode.classList.add('hidden');
    numMode.classList.remove('hidden');
  };

  // OTP input
  const savedNum = localStorage.getItem(LS_NUM);
  const otpStu = document.getElementById('otpStudent');
  const getOtpValue = bindOtp(otpStu, (val) => doLogin(active.code, { studentId: val }));
  if (savedNum && /^\d{6}$/.test(savedNum)) {
    [...otpStu.querySelectorAll('input')].forEach((inp, i) => { inp.value = savedNum[i]; });
  }

  document.getElementById('loginBtn').onclick = () => {
    const val = getOtpValue();
    doLogin(active.code, { studentId: val });
  };

  // İsim+sınıf login pre-fill
  const lastName = localStorage.getItem(LS_NAME);
  const lastSinif = localStorage.getItem(LS_SINIF);
  if (lastName) {
    document.getElementById('loginName').value = lastName;
    document.getElementById('fName').value = lastName;
  }
  if (lastSinif) {
    document.getElementById('loginSinif').value = lastSinif;
    document.getElementById('fSinif').value = lastSinif;
  }
  document.getElementById('loginByNameBtn').onclick = () => {
    const name = document.getElementById('loginName').value.trim();
    const sinif = document.getElementById('loginSinif').value.trim();
    if (!name) { showJoinErr('Ad Soyad gerekli'); return; }
    doLogin(active.code, { name, sinif });
  };

  // Yeni kayıt sekmesi
  document.getElementById('registerBtn').onclick = async () => {
    const name = document.getElementById('fName').value.trim();
    const sinif = document.getElementById('fSinif').value.trim();
    if (!name) return showJoinErr('Ad Soyad gerekli');
    try {
      const r = await api('/api/student/register', {
        method: 'POST',
        body: { code: active.code, name, sinif }
      });
      localStorage.setItem(LS_NAME, name);
      localStorage.setItem(LS_SINIF, sinif);
      localStorage.setItem(LS_NUM, r.studentId);
      renderRegDone(r, /*comingFromQuiz*/ true);
    } catch (e) {
      showJoinErr(e.message);
    }
  };
}

function showJoinErr(m) {
  const err = document.getElementById('joinError');
  if (!err) { showToast(m, 'bad'); return; }
  err.textContent = m;
  err.classList.remove('hidden');
}

async function doLogin(code, opts) {
  const err = document.getElementById('joinError');
  if (err) err.classList.add('hidden');

  // opts: { studentId } veya { name, sinif }
  if (opts.studentId) {
    if (!/^\d{6}$/.test(opts.studentId)) {
      showJoinErr('6 haneli numarayı tam gir');
      return;
    }
  } else if (opts.name) {
    if (!opts.name.trim()) { showJoinErr('Ad Soyad gerekli'); return; }
  }

  try {
    const data = await api('/api/student/login', {
      method: 'POST',
      body: { code, ...opts }
    });
    if (data.accessToken) setAccessToken(data.accessToken);
    localStorage.setItem(LS_NUM, data.studentId);
    if (data.name) localStorage.setItem(LS_NAME, data.name);
    if (data.sinif !== undefined) localStorage.setItem(LS_SINIF, data.sinif);
    localStorage.setItem(LS_KEY, JSON.stringify({ resultId: data.participantId, sessionId: data.sessionId }));
    enterQuiz(data);
  } catch (e) {
    if (e.payload?.alreadyTaken) {
      renderAlreadyTaken();
      return;
    }
    showJoinErr(e.message);
  }
}

function renderAlreadyTaken() {
  currentScreen = 'taken';
  stopPoll();
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-already-taken'));
  document.getElementById('backToStart').onclick = start;
}

// ============================================================
//  Quiz çözme ekranı
// ============================================================
let state = null;
function enterQuiz({ participantId, quiz, answers }) {
  currentScreen = 'quiz';
  stopPoll();
  state = {
    participantId,
    quiz,
    answers: {},
    currentIdx: 0,
    totalDeadline: null,
    perQDeadline: null,
    timerInterval: null
  };
  (answers || []).forEach(a => { state.answers[a.questionId] = a.value; });

  if (quiz.timeMode === 'total' && quiz.timeValue > 0) {
    let dl = localStorage.getItem(LS_KEY + '_deadline_' + participantId);
    if (!dl) {
      dl = Date.now() + quiz.timeValue * 60 * 1000;
      localStorage.setItem(LS_KEY + '_deadline_' + participantId, dl);
    }
    state.totalDeadline = Number(dl);
  }

  app.innerHTML = '';
  app.appendChild(tplClone('tpl-quiz'));
  document.getElementById('prevBtn').onclick = () => goto(state.currentIdx - 1);
  document.getElementById('nextBtn').onclick = () => goto(state.currentIdx + 1);
  document.getElementById('submitBtn').onclick = onSubmit;

  renderQuestion();
  startTimerLoop();
}

function renderQuestion() {
  const q = state.quiz.questions[state.currentIdx];
  const area = document.getElementById('questionArea');
  document.getElementById('qProgress').textContent = `${state.currentIdx + 1} / ${state.quiz.questions.length}`;

  area.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card question-card';
  const imageHTML = q.image
    ? `<div class="q-image-display"><img src="/uploads/${encodeURIComponent(q.image)}" alt="Soru resmi" /></div>`
    : '';
  card.innerHTML = `
    <div class="muted small">${typeLabel(q.type)} · ${q.points || 1} puan</div>
    ${imageHTML}
    <h2 class="q-text-display">${escapeHtml(q.text)}</h2>
    <div class="q-input"></div>
  `;
  const input = card.querySelector('.q-input');

  if (q.type === 'multiple_choice') {
    const grid = document.createElement('div');
    grid.className = 'options-grid';
    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      if (opt.image) btn.classList.add('has-image');
      const optImgHTML = opt.image
        ? `<img class="opt-image" src="/uploads/${encodeURIComponent(opt.image)}" alt="" />`
        : '';
      btn.innerHTML = `${optImgHTML}<span class="opt-text-display">${escapeHtml(opt.text || '')}</span>`;
      const sendValue = (opt.pos !== undefined) ? opt.pos : opt.idx;
      const saved = state.answers[q.id];
      if (saved !== undefined && (saved === sendValue || saved === i)) {
        btn.classList.add('selected');
      }
      btn.onclick = () => {
        grid.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        saveAnswer(q.id, sendValue);
      };
      grid.appendChild(btn);
    });
    input.appendChild(grid);
  } else if (q.type === 'true_false') {
    const grid = document.createElement('div');
    grid.className = 'options-grid';
    [{ v: true, l: '✓ Doğru' }, { v: false, l: '✗ Yanlış' }].forEach(({ v, l }) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = l;
      if (state.answers[q.id] === v) btn.classList.add('selected');
      btn.onclick = () => {
        grid.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        saveAnswer(q.id, v);
      };
      grid.appendChild(btn);
    });
    input.appendChild(grid);
  } else if (q.type === 'open_ended') {
    const ta = document.createElement('textarea');
    ta.rows = 6;
    ta.placeholder = 'Cevabını buraya yaz...';
    ta.value = state.answers[q.id] || '';
    let timer;
    ta.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveAnswer(q.id, ta.value), 400);
    };
    ta.onblur = () => saveAnswer(q.id, ta.value);
    input.appendChild(ta);
  }

  area.appendChild(card);

  document.getElementById('prevBtn').disabled = state.currentIdx === 0;
  const isLast = state.currentIdx === state.quiz.questions.length - 1;
  document.getElementById('nextBtn').classList.toggle('hidden', isLast);
  document.getElementById('submitBtn').classList.toggle('hidden', !isLast);

  if (state.quiz.timeMode === 'per_question' && state.quiz.timeValue > 0) {
    state.perQDeadline = Date.now() + state.quiz.timeValue * 1000;
  }
}

function goto(idx) {
  if (idx < 0 || idx >= state.quiz.questions.length) return;
  state.currentIdx = idx;
  renderQuestion();
}

async function saveAnswer(qid, value) {
  state.answers[qid] = value;
  try {
    await api('/api/student/answer', { method: 'POST', body: { resultId: state.participantId, questionId: qid, value } });
  } catch (e) { /* offline tolerance */ }
}

function startTimerLoop() {
  if (state.quiz.timeMode === 'unlimited') return;
  document.getElementById('timerWrap').classList.remove('hidden');
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(tickTimer, 250);
  tickTimer();
}

function tickTimer() {
  const label = document.getElementById('timerLabel');
  const fill = document.getElementById('timerFill');
  if (state.quiz.timeMode === 'total') {
    const remaining = state.totalDeadline - Date.now();
    if (remaining <= 0) {
      label.textContent = '00:00';
      fill.style.width = '0%';
      clearInterval(state.timerInterval);
      onSubmit(true);
      return;
    }
    const total = state.quiz.timeValue * 60 * 1000;
    label.textContent = formatTime(remaining);
    fill.style.width = (remaining / total * 100) + '%';
  } else if (state.quiz.timeMode === 'per_question') {
    const remaining = state.perQDeadline - Date.now();
    const total = state.quiz.timeValue * 1000;
    if (remaining <= 0) {
      label.textContent = '00:00';
      fill.style.width = '0%';
      if (state.currentIdx === state.quiz.questions.length - 1) {
        clearInterval(state.timerInterval);
        onSubmit(true);
      } else {
        goto(state.currentIdx + 1);
      }
      return;
    }
    label.textContent = formatTime(remaining);
    fill.style.width = (remaining / total * 100) + '%';
  }
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function onSubmit(timeUp = false) {
  // Tek tık ile teslim (admin tarafıyla tutarlı UX). Kazara basışa karşı buton "Teslim Et ✓" şeklinde explicit, kazara basma ihtimali düşük.
  if (state.timerInterval) clearInterval(state.timerInterval);
  try {
    const res = await api('/api/student/submit', { method: 'POST', body: { resultId: state.participantId } });
    // Bulgu 15: paylaşılan cihaz hijyeni — submit sonrası kişisel bilgileri temizle
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_KEY + '_deadline_' + state.participantId);
    localStorage.removeItem(LS_NUM);
    localStorage.removeItem(LS_NAME);
    localStorage.removeItem(LS_SINIF);
    clearAccessToken();
    renderDone(res, timeUp);
  } catch (e) {
    showToast('Teslim edilemedi: ' + e.message, 'bad', 4000);
    reportError('submit failed: ' + e.message);
  }
}

function renderDone(result, timeUp) {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-done'));
  document.getElementById('doneMsg').textContent = result.awaitingGrading
    ? (timeUp ? 'Süren doldu, cevapların kaydedildi. Açık uçlu sorular öğretmen tarafından okunacak.' : 'Cevapların kaydedildi. Açık uçlu sorular öğretmen tarafından okunacak.')
    : (timeUp ? 'Süren doldu, cevapların değerlendirildi.' : 'Cevapların değerlendirildi.');
  document.getElementById('doneScore').textContent = result.awaitingGrading ? '— ' : `${result.totalScore || 0}`;
}

function typeLabel(t) {
  return { multiple_choice: 'Çoktan Seçmeli', true_false: 'Doğru/Yanlış', open_ended: 'Açık Uçlu' }[t] || t;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

start();
