// ============================================================
//  Quiz Admin SPA
// ============================================================
const app = document.getElementById('app');
const socket = io();

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    err.silent = true; // beklenen API hatası — global reporter atla
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function tplClone(id) {
  const t = document.getElementById(id);
  if (!t) { console.error('template yok:', id); return document.createDocumentFragment(); }
  return t.content.cloneNode(true);
}

// ---------- Toast bildirim ----------
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

// ---------- Navigation kaynak takibi (nav:from) ----------
const NavCtx = {
  set(from) { sessionStorage.setItem('nav:from', from); },
  get() { return sessionStorage.getItem('nav:from') || ''; },
  clear() { sessionStorage.removeItem('nav:from'); }
};

// ---------- Router ----------
function navigate() {
  setActiveNav();
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);

  if (hash === '/') return renderDashboard();
  if (parts[0] === 'quizzes') return renderQuizList();
  if (parts[0] === 'editor' && parts[1] === 'new') return renderEditor(null);
  if (parts[0] === 'editor' && parts[1]) return renderEditor(parts[1]);
  if (parts[0] === 'sessions') return renderSessionsAll();
  if (parts[0] === 'session' && parts[1]) return renderSessionDetail(parts[1]);
  if (parts[0] === 'students' && !parts[1]) return renderStudentsAll();
  if (parts[0] === 'student' && parts[1] && parts[2] === 'session' && parts[3]) {
    return renderQADetail(parts[1], parts[3]);
  }
  if (parts[0] === 'student' && parts[1]) return renderStudentProfile(parts[1]);
  // Eski deprecated route — redirect
  if (parts[0] === 'result' && parts[1]) return redirectLegacyResult(parts[1]);
  if (parts[0] === 'settings') return renderSettings();
  if (parts[0] === 'logs') return renderLogs();
  if (parts[0] === 'registration') return renderRegistration();
  return renderDashboard();
}
window.addEventListener('hashchange', navigate);

function setActiveNav() {
  const hash = location.hash || '#/';
  document.querySelectorAll('header nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });
}

// ---------- Breadcrumb ----------
function renderCrumbs(items) {
  // items: [{label, hash?}], son eleman hash'siz olur
  const host = document.getElementById('crumbsHere');
  if (!host) return;
  const frag = tplClone('tpl-crumbs');
  const ol = frag.querySelector('#crumbList');
  items.forEach((it, idx) => {
    const li = document.createElement('li');
    if (it.hash && idx < items.length - 1) {
      const a = document.createElement('a');
      a.href = it.hash;
      a.textContent = it.label;
      a.addEventListener('click', () => NavCtx.set(it.from || ''));
      li.appendChild(a);
    } else {
      li.textContent = it.label;
      li.setAttribute('aria-current', 'page');
    }
    ol.appendChild(li);
  });
  host.appendChild(frag);
}

// ============================================================
//  DASHBOARD
// ============================================================
async function renderDashboard() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-dashboard'));

  document.getElementById('newQuizBtn').onclick = () => location.hash = '#/editor/new';

  const startRegBtn = document.getElementById('startRegBtn');
  if (startRegBtn) {
    startRegBtn.onclick = async () => {
      try {
        await api('/api/admin/sessions/start', { method: 'POST', body: { kind: 'registration' } });
        showToast('Kayıt oturumu başlatıldı', 'good');
        location.hash = '#/registration';
      } catch (e) { showToast(e.message, 'bad'); }
    };
  }

  const state = await api('/api/admin/state');
  // Aktif kayıt oturumu varsa direkt o ekrana yönlendir
  if (state.activeSession && state.activeSession.kind === 'registration') {
    location.hash = '#/registration';
    return;
  }
  renderActiveSession(state.activeSession);

  const list = document.getElementById('dashQuizList');
  if (!state.quizzes.length) {
    list.innerHTML = '<p class="muted">Henüz quiz yok.</p>';
  } else {
    list.innerHTML = '';
    state.quizzes.forEach(q => list.appendChild(quizRow(q, state.activeSession)));
  }

  const sl = document.getElementById('dashSessionList');
  if (!state.sessions.length) {
    sl.innerHTML = '<p class="muted">Henüz tamamlanmış oturum yok.</p>';
  } else {
    sl.innerHTML = '';
    state.sessions.slice(0, 5).forEach(s => sl.appendChild(sessionRow(s)));
  }
}

function quizRow(quiz, activeSession) {
  const row = document.createElement('div');
  row.className = 'list-row';
  const timeLabel = quiz.timeMode === 'unlimited' ? 'süresiz'
    : quiz.timeMode === 'total' ? `${quiz.timeValue} dk`
    : `${quiz.timeValue} sn/soru`;
  row.innerHTML = `
    <div class="list-row-main">
      <strong>${escapeHtml(quiz.title)}</strong>
      <div class="muted small">${quiz.questionCount} soru · ${timeLabel}</div>
    </div>
    <div class="row" style="gap:6px;">
      <button class="btn-secondary small" data-edit>Düzenle</button>
      <button class="btn-good small" data-start>${activeSession ? 'Bunu Başlat' : 'Başlat'}</button>
      <button class="btn-danger small" data-del>Sil</button>
    </div>
  `;
  row.querySelector('[data-edit]').onclick = (e) => {
    e.stopPropagation();
    location.hash = `#/editor/${quiz.id}`;
  };
  row.querySelector('[data-start]').onclick = (e) => {
    e.stopPropagation();
    showStartQuizModal(quiz);
  };
  row.querySelector('[data-del]').onclick = async (e) => {
    e.stopPropagation();
    showDeleteQuizModal(quiz);
  };
  return row;
}

function sessionRow(s) {
  const row = document.createElement('div');
  row.className = 'list-row';
  const ts = new Date(s.endedAt || s.startedAt).toLocaleString('tr-TR');
  const ungraded = s.ungradedCount > 0
    ? `<span class="badge bad">${s.ungradedCount} puanlanmamış</span>` : '';
  row.innerHTML = `
    <div class="list-row-main">
      <strong>${escapeHtml(s.quizTitle)}</strong>
      <div class="muted small">${ts} · ${s.participantCount} katılımcı ${ungraded}</div>
    </div>
    <div><button class="btn-secondary small">Detay →</button></div>
  `;
  row.onclick = () => {
    NavCtx.set('sessions');
    location.hash = `#/session/${s.id}`;
  };
  return row;
}

function renderActiveSession(active) {
  const card = document.querySelector('.active-session-card');
  if (!active) {
    card.dataset.active = 'false';
    card.querySelector('.active-empty').classList.remove('hidden');
    card.querySelector('.active-live').classList.add('hidden');
    return;
  }
  card.dataset.active = 'true';
  card.querySelector('.active-empty').classList.add('hidden');
  card.querySelector('.active-live').classList.remove('hidden');

  card.querySelector('#activeTitle').textContent = active.meta.quizTitle || '';
  card.querySelector('#activeCode').textContent = active.code;
  card.querySelector('#activeQr').src = active.meta.qrDataUrl;
  card.querySelector('#activeUrls').innerHTML =
    'Öğrenci adresi: <strong>' + escapeHtml(active.meta.joinUrl) + '</strong>';
  card.querySelector('#activeStatus').textContent =
    `${active.meta.participantCount} katılımcı · ${active.meta.submittedCount} teslim edildi`;

  card.querySelector('#endSessionBtn').onclick = async () => {
    try {
      await api(`/api/admin/sessions/${active.id}/end`, { method: 'POST' });
      showToast('Oturum bitirildi', 'good');
      navigate();
    } catch (err) { showToast(err.message, 'bad'); }
  };
  card.querySelector('#viewSessionBtn').onclick = () => {
    NavCtx.set('dashboard');
    location.hash = `#/session/${active.id}`;
  };
}

// ============================================================
//  QUIZ LİSTESİ
// ============================================================
async function renderQuizList() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-quizzes'));
  document.getElementById('newQuizBtn2').onclick = () => location.hash = '#/editor/new';
  const state = await api('/api/admin/state');
  const list = document.getElementById('quizFullList');
  if (!state.quizzes.length) {
    list.innerHTML = '<p class="muted">Henüz quiz yok.</p>';
  } else {
    list.innerHTML = '';
    state.quizzes.forEach(q => list.appendChild(quizRow(q, state.activeSession)));
  }
}

// ============================================================
//  QUIZ EDİTÖR
// ============================================================
async function renderEditor(quizId) {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-editor'));
  renderCrumbs([
    { label: 'Quizler', hash: '#/quizzes' },
    { label: quizId ? 'Düzenle' : 'Yeni Quiz' }
  ]);
  document.getElementById('editorTitle').textContent = quizId ? 'Quiz Düzenle' : 'Yeni Quiz';

  const timeMode = document.getElementById('qTimeMode');
  const timeWrap = document.getElementById('timeValueWrap');
  const timeLabel = document.getElementById('timeValueLabel');
  function updateTimeUI() {
    if (timeMode.value === 'unlimited') {
      timeWrap.classList.add('hidden');
    } else {
      timeWrap.classList.remove('hidden');
      timeLabel.textContent = timeMode.value === 'total' ? 'Toplam dakika' : 'Soru başına saniye';
    }
  }
  timeMode.addEventListener('change', updateTimeUI);
  updateTimeUI();

  const qList = document.getElementById('questionsList');

  if (quizId) {
    const quiz = await api(`/api/admin/quizzes/${quizId}`);
    document.getElementById('qTitle').value = quiz.title;
    timeMode.value = quiz.timeMode;
    document.getElementById('qTimeValue').value = quiz.timeValue || 1;
    document.getElementById('qShuffleQ').checked = !!quiz.shuffleQuestions;
    document.getElementById('qShuffleOpt').checked = !!quiz.shuffleOptions;
    updateTimeUI();
    quiz.questions.forEach(q => qList.appendChild(buildQuestionEditor(q)));
    reindexQuestions();
  }

  document.querySelectorAll('[data-add]').forEach(b => {
    b.onclick = () => {
      qList.appendChild(buildQuestionEditor({ type: b.dataset.add }));
      reindexQuestions();
    };
  });

  // Bulgu 18: kaydedilmemiş değişiklik uyarısı
  let _editorDirty = false;
  const _markDirty = () => { _editorDirty = true; };
  // Tüm input/textarea/select değişikliklerini izle
  document.getElementById('app').addEventListener('input', _markDirty, true);
  document.getElementById('app').addEventListener('change', _markDirty, true);
  // Soru eklemek/silmek de dirty
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', _markDirty));

  // beforeunload kaldırıldı — kullanıcı tek tık istiyor; iptal'de toast uyarısı var.
  const _beforeUnloadHandler = null;
  const _cleanup = () => window.removeEventListener('beforeunload', _beforeUnloadHandler);

  document.getElementById('cancelEdit').onclick = () => {
    if (_editorDirty) showToast('Kaydedilmemiş değişiklikler iptal edildi', 'warn');
    _cleanup();
    location.hash = '#/quizzes';
  };
  document.getElementById('saveQuiz').onclick = async () => {
    try {
      const payload = collectQuizPayload();
      if (quizId) await api(`/api/admin/quizzes/${quizId}`, { method: 'PUT', body: payload });
      else await api('/api/admin/quizzes', { method: 'POST', body: payload });
      _editorDirty = false;
      _cleanup();
      location.hash = '#/quizzes';
    } catch (e) { showToast(e.message, 'bad'); }
  };
}

// Bir File'ı sunucuya yükle, filename döner
async function uploadImage(file) {
  if (!file) return null;
  if (file.size > 2 * 1024 * 1024) throw new Error('Resim çok büyük (max 2 MB)');
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Dosya okunamadı'));
    fr.readAsDataURL(file);
  });
  const r = await api('/api/admin/upload', { method: 'POST', body: { dataUrl } });
  return r.filename;
}

// Soru kartı içindeki .q-image-block'u bağla (soru-seviyesi resim)
function bindQuestionImageBlock(qcard, initialFilename) {
  // Sadece soru kartının doğrudan altındaki bloğu seç (option-row içindekini değil)
  const block = [...qcard.children].find(el => el.classList?.contains('q-image-block'));
  if (!block) return;
  const preview = block.querySelector('.q-image-preview');
  const thumb = block.querySelector('.q-image-thumb');
  const addBtn = block.querySelector('.add-img');
  const removeBtn = block.querySelector('.remove-img');
  const input = block.querySelector('.img-input');

  function set(filename) {
    if (filename) {
      block.dataset.imageFilename = filename;
      thumb.src = '/uploads/' + filename;
      preview.classList.remove('hidden');
      addBtn.classList.add('hidden');
    } else {
      block.dataset.imageFilename = '';
      preview.classList.add('hidden');
      addBtn.classList.remove('hidden');
    }
    _editorDirty = true;
  }

  if (initialFilename) set(initialFilename);

  addBtn.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      addBtn.disabled = true;
      const orig = addBtn.innerHTML;
      addBtn.innerHTML = '⏳ Yükleniyor...';
      const filename = await uploadImage(file);
      set(filename);
      addBtn.innerHTML = orig;
    } catch (e) {
      showToast(e.message, 'bad');
      addBtn.innerHTML = '🖼 Soruya resim ekle';
    } finally {
      addBtn.disabled = false;
      input.value = '';
    }
  };
  removeBtn.onclick = () => set(null);
}

// Bir şık satırına resim ekleme/kaldırma binding'i
function bindOptionImage(row, initialFilename) {
  const imgBtn = row.querySelector('.opt-img-btn');
  const thumbWrap = row.querySelector('.opt-img-thumb-wrap');
  const thumb = row.querySelector('.opt-img-thumb');
  const input = row.querySelector('.opt-img-input');
  const removeBtn = row.querySelector('.opt-img-remove');

  function set(filename) {
    if (filename) {
      row.dataset.optImage = filename;
      thumb.src = '/uploads/' + filename;
      thumbWrap.classList.remove('hidden');
      imgBtn.classList.add('hidden');
    } else {
      row.dataset.optImage = '';
      thumbWrap.classList.add('hidden');
      imgBtn.classList.remove('hidden');
    }
    _editorDirty = true;
  }
  if (initialFilename) set(initialFilename);

  imgBtn.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      imgBtn.disabled = true;
      const filename = await uploadImage(file);
      set(filename);
    } catch (e) {
      showToast(e.message, 'bad');
    } finally {
      imgBtn.disabled = false;
      input.value = '';
    }
  };
  removeBtn.onclick = () => set(null);
}

function buildQuestionEditor(q) {
  let node;
  if (q.type === 'multiple_choice') {
    node = tplClone('tpl-question-mc').firstElementChild;
    const optWrap = node.querySelector('.options-editor');
    const addOptBtn = node.querySelector('.add-option');

    // Üste açıklama
    const help = document.createElement('p');
    help.className = 'muted small mark-correct-help';
    help.innerHTML = '↓ Şıkları yaz ve <strong>"Doğru cevap" butonuyla doğru şıkkı işaretle</strong>. Aynı butona tekrar basarak iptal edebilirsin. Her şıkka isteğe bağlı resim ekleyebilirsin.';
    optWrap.parentNode.insertBefore(help, optWrap);

    function setCorrect(row) {
      const isCurrentlyCorrect = row.dataset.correct === 'true';
      optWrap.querySelectorAll('.option-row').forEach(r => {
        r.dataset.correct = 'false';
        const b = r.querySelector('.mark-correct');
        if (b) {
          b.classList.remove('active');
          b.innerHTML = '<span class="mark-circle">○</span> Doğru cevap';
        }
      });
      if (!isCurrentlyCorrect) {
        row.dataset.correct = 'true';
        const b = row.querySelector('.mark-correct');
        b.classList.add('active');
        b.innerHTML = '<span class="mark-circle">●</span> ✓ Doğru cevap';
      }
    }

    function addOption(text = '', isCorrect = false, imageFilename = null) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.dataset.correct = isCorrect ? 'true' : 'false';
      row.innerHTML = `
        <button type="button" class="mark-correct${isCorrect ? ' active' : ''}">
          <span class="mark-circle">${isCorrect ? '●' : '○'}</span> ${isCorrect ? '✓ Doğru cevap' : 'Doğru cevap'}
        </button>
        <input type="text" class="opt-text" placeholder="Şık metni" value="${escapeAttr(text)}" />
        <button class="opt-img-btn btn-secondary small" type="button" title="Şıka resim ekle">🖼</button>
        <span class="opt-img-thumb-wrap hidden">
          <img class="opt-img-thumb" alt="" />
          <button type="button" class="opt-img-remove" title="Resmi kaldır">×</button>
        </span>
        <input type="file" class="opt-img-input" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
        <button class="btn-danger small remove-opt" type="button" title="Şıkkı sil">×</button>
      `;
      row.querySelector('.mark-correct').onclick = () => setCorrect(row);
      row.querySelector('.remove-opt').onclick = () => row.remove();
      bindOptionImage(row, imageFilename);
      optWrap.appendChild(row);
    }
    addOptBtn.onclick = () => addOption('', false);
    if (q.options) q.options.forEach((o, i) => addOption(o, i === q.correctIndex, q.optionImages?.[i] || null));
    else { addOption('', true); addOption('', false); addOption('', false); addOption('', false); }
  } else if (q.type === 'true_false') {
    node = tplClone('tpl-question-tf').firstElementChild;
    if (q.correctBool === true) node.querySelector('.q-tf[value="true"]').checked = true;
    if (q.correctBool === false) node.querySelector('.q-tf[value="false"]').checked = true;
  } else {
    node = tplClone('tpl-question-open').firstElementChild;
  }
  if (q.text) node.querySelector('.q-text').value = q.text;
  if (q.points) node.querySelector('.q-points').value = q.points;
  if (q.id) node.dataset.qid = q.id;

  // Soru-seviyesi resim binding (her tipte)
  bindQuestionImageBlock(node, q.image || null);

  node.querySelector('.q-remove').onclick = () => {
    node.remove();
    reindexQuestions();
    _editorDirty = true;
  };
  return node;
}

function reindexQuestions() {
  document.querySelectorAll('.q-card').forEach((card, i) => {
    card.querySelector('.q-index').textContent = `Soru ${i + 1}`;
  });
}

function collectQuizPayload() {
  const title = document.getElementById('qTitle').value.trim();
  if (!title) throw new Error('Başlık boş olamaz');
  const timeMode = document.getElementById('qTimeMode').value;
  const timeValue = Number(document.getElementById('qTimeValue').value) || 0;
  const questions = [];
  document.querySelectorAll('.q-card').forEach(card => {
    const type = card.dataset.type;
    const text = card.querySelector('.q-text').value.trim();
    // Soru resmi (kart doğrudan altındaki blok)
    const qImageBlock = [...card.children].find(el => el.classList?.contains('q-image-block'));
    const questionImage = qImageBlock?.dataset.imageFilename || '';
    if (!text && !questionImage) throw new Error('Bir sorunun ne metni ne resmi var — biri gerekli');
    const points = Number(card.querySelector('.q-points').value) || 1;
    const q = { id: card.dataset.qid, type, text, points };
    if (questionImage) q.image = questionImage;
    if (type === 'multiple_choice') {
      const rows = [...card.querySelectorAll('.option-row')];
      const opts = rows.map(r => r.querySelector('.opt-text').value.trim());
      const optImgs = rows.map(r => r.dataset.optImage || null);
      const correctIndex = rows.findIndex(r => r.dataset.correct === 'true');
      // Bir şıkkın text'i veya resmi olmalı
      const validCount = rows.filter(r => r.querySelector('.opt-text').value.trim() || r.dataset.optImage).length;
      if (validCount < 2) throw new Error('Çoktan seçmeli soruda en az 2 şık olmalı (metin veya resim): "' + text.slice(0, 30) + '..."');
      if (correctIndex < 0) throw new Error('Doğru cevap işaretlenmemiş: "' + text.slice(0, 30) + '...". Doğru şıkkın yanındaki yeşil "Doğru cevap" butonuna tıkla.');
      q.options = opts;
      q.optionImages = optImgs;
      q.correctIndex = correctIndex;
    } else if (type === 'true_false') {
      const chosen = card.querySelector('.q-tf:checked');
      if (!chosen) throw new Error('Doğru/Yanlış seçilmemiş: "' + text.slice(0, 30) + '..."');
      q.correctBool = chosen.value === 'true';
    }
    questions.push(q);
  });
  if (!questions.length) throw new Error('En az bir soru ekle');
  return {
    title, timeMode, timeValue,
    shuffleQuestions: document.getElementById('qShuffleQ').checked,
    shuffleOptions: document.getElementById('qShuffleOpt').checked,
    questions
  };
}

// ============================================================
//  GEÇMİŞ OTURUMLAR (liste)
// ============================================================
async function renderSessionsAll() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-sessions'));
  const state = await api('/api/admin/state');
  const list = document.getElementById('sessionListAll');
  if (!state.sessions.length) {
    list.innerHTML = '<p class="muted">Henüz tamamlanmış oturum yok.</p>';
  } else {
    list.innerHTML = '';
    state.sessions.forEach(s => list.appendChild(sessionRow(s)));
  }
}

// ============================================================
//  OTURUM DETAYI (katılımcı tablosu)
// ============================================================
let currentSessionId = null;
async function renderSessionDetail(sessionId) {
  currentSessionId = sessionId;
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-session-detail'));

  const data = await api(`/api/admin/sessions/${sessionId}`);
  const isLive = data.session.status === 'live';

  renderCrumbs([
    { label: 'Geçmiş Oturumlar', hash: '#/sessions', from: 'sessions' },
    { label: data.quiz?.title || 'Oturum' }
  ]);

  document.getElementById('sessTitle').textContent = isLive ? 'Canlı Oturum' : 'Tamamlanmış Oturum';
  document.getElementById('sessQuiz').textContent = data.quiz?.title || '';
  document.getElementById('sessCode').textContent = data.session.code;
  document.getElementById('csvDownload').href = `/api/admin/sessions/${sessionId}/csv`;

  const tbody = document.getElementById('sessParticipants');
  function renderTable(results) {
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">Henüz katılımcı yok.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    results.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
    results.forEach(r => {
      const tr = document.createElement('tr');
      const statusLabel = statusBadge(r.status);
      const stuId = encodeStuId(r.name, r.sinif);
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.sinif || '-')}</td>
        <td>${statusLabel}</td>
        <td><strong>${r.totalScore || 0}</strong></td>
        <td><button class="btn-secondary small">Cevapları Gör →</button></td>
      `;
      tr.onclick = () => {
        NavCtx.set('session:' + sessionId);
        location.hash = `#/student/${stuId}/session/${sessionId}`;
      };
      tr.style.cursor = 'pointer';
      tbody.appendChild(tr);
    });
  }
  renderTable(data.results);

  socket.off('student:joined');
  socket.off('student:submitted');
  const refresh = async () => {
    if (currentSessionId !== sessionId) return;
    const fresh = await api(`/api/admin/sessions/${sessionId}`);
    renderTable(fresh.results);
  };
  socket.on('student:joined', refresh);
  socket.on('student:submitted', refresh);
}

// ============================================================
//  ÖĞRENCİ LİSTESİ
// ============================================================
async function renderStudentsAll() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-students'));

  // Ekleme formu
  document.getElementById('addStudentBtn').onclick = () => {
    const form = document.getElementById('addStudentForm');
    form.open = !form.open;
    if (form.open) document.getElementById('newStuName').focus();
  };
  document.getElementById('saveStuBtn').onclick = async () => {
    const name = document.getElementById('newStuName').value.trim();
    const sinif = document.getElementById('newStuSinif').value.trim();
    const id = document.getElementById('newStuId').value.trim();
    if (!name) return showToast('Ad Soyad gerekli', 'bad');
    try {
      const stu = await api('/api/admin/students', { method: 'POST', body: { name, sinif, id: id || undefined } });
      showToast(`Eklendi: ${stu.name} (numara: ${stu.id})`, 'good', 4000);
      renderStudentsAll();
    } catch (e) { showToast(e.message, 'bad'); }
  };

  // Tüm öğrenciler — students-list endpoint'i (manuel eklenenler dahil)
  const students = await api('/api/admin/students-list');
  const list = document.getElementById('studentListAll');
  if (!students.length) {
    list.innerHTML = '<p class="muted">Henüz öğrenci yok. "Yeni öğrenci ekle" diyerek manuel ekleyebilir veya "Kayıt Başlat" ile toplu kayıt oturumu açabilirsin.</p>';
    return;
  }
  list.innerHTML = '';
  students.forEach(stu => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const initials = (stu.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
    row.innerHTML = `
      <div class="student-avatar" style="width:42px;height:42px;font-size:16px;">${initials}</div>
      <div class="list-row-main">
        <strong>${escapeHtml(stu.name)}</strong>
        <div class="muted small">${escapeHtml(stu.sinif || '-')} · ${stu.quizCount} quiz · ${stu.totalScore} puan</div>
      </div>
      <span class="student-num">${stu.id}</span>
      <div><button class="btn-secondary small">Profil →</button></div>
    `;
    row.onclick = () => {
      NavCtx.set('students');
      location.hash = `#/student/${stu.id}`;
    };
    list.appendChild(row);
  });
}

// ============================================================
//  ÖĞRENCİ PROFİLİ (yeni)
// ============================================================
async function renderStudentProfile(stuId) {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-student-profile'));

  try {
    const data = await api(`/api/admin/students/${stuId}`);
    const stu = data.student;
    renderCrumbs([
      { label: 'Öğrenciler', hash: '#/students', from: 'students' },
      { label: stu.name }
    ]);

    const initials = stu.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
    document.getElementById('stuAvatar').textContent = initials;
    document.getElementById('stuName').textContent = stu.name;
    document.getElementById('stuSinif').textContent = stu.sinif || '-';
    document.getElementById('stuStats').textContent = `${stu.quizCount} quiz · Toplam ${stu.totalScore} puan`;

    // Numara göster (yalnızca yeni model — 6 hane ise)
    if (/^\d{6}$/.test(stuId)) {
      const numEl = document.getElementById('stuNumDisplay');
      numEl.textContent = '№ ' + stuId;
      numEl.classList.remove('hidden');
    }

    // Öğrenciyi sil
    const delBtn = document.getElementById('deleteStudentBtn');
    if (/^\d{6}$/.test(stuId)) {
      delBtn.onclick = async () => {
        try {
          await api(`/api/admin/students/${stuId}`, { method: 'DELETE' });
          showToast(`${stu.name} silindi`, 'good');
          location.hash = '#/students';
        } catch (e) { showToast(e.message, 'bad'); }
      };
    } else {
      // Eski (base64) stuId'li öğrenciler — onlar henüz students tablosunda yok
      delBtn.style.display = 'none';
    }

    const list = document.getElementById('stuSessionList');
    if (!data.sessions.length) {
      list.innerHTML = '<p class="muted">Bu öğrenci henüz quiz çözmedi.</p>';
      return;
    }
    list.innerHTML = '';
    data.sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const ts = s.submittedAt ? new Date(s.submittedAt).toLocaleString('tr-TR') : '(devam ediyor)';
      row.innerHTML = `
        <div class="list-row-main">
          <strong>${escapeHtml(s.quizTitle)}</strong>
          <div class="muted small">${ts}</div>
        </div>
        <div class="row" style="gap:8px;">
          ${statusBadge(s.status)}
          <strong style="min-width:50px;text-align:right;">${s.score} puan</strong>
          <button class="btn-secondary small" data-action="view">Cevaplar →</button>
          <button class="btn-danger small" data-action="delete" title="Bu sonucu sil — öğrenci sınava tekrar girebilir">🗑</button>
        </div>
      `;
      row.querySelector('[data-action="view"]').onclick = (e) => {
        e.stopPropagation();
        NavCtx.set('student:' + stuId);
        location.hash = `#/student/${stuId}/session/${s.sessionId}`;
      };
      row.querySelector('[data-action="delete"]').onclick = async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/admin/results/${s.resultId}`, { method: 'DELETE' });
          showToast(`"${s.quizTitle}" sonucu silindi — tekrar girebilir`, 'good', 3500);
          renderStudentProfile(stuId);
        } catch (e) { showToast(e.message, 'bad'); }
      };
      row.onclick = () => {
        NavCtx.set('student:' + stuId);
        location.hash = `#/student/${stuId}/session/${s.sessionId}`;
      };
      list.appendChild(row);
    });
  } catch (e) {
    app.innerHTML = `<div class="card error">Öğrenci bulunamadı: ${escapeHtml(e.message)}</div>`;
  }
}

// ============================================================
//  Q&A DETAY (compact accordion — kanonik route)
// ============================================================
async function renderQADetail(stuId, sessionId) {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-qa-detail'));

  let data;
  try {
    data = await api(`/api/admin/students/${stuId}/session/${sessionId}`);
  } catch (e) {
    app.innerHTML = `<div class="card error">Bulunamadı: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const { result, quiz, session } = data;

  // Breadcrumb: nereden geldim?
  const from = NavCtx.get();
  if (from.startsWith('student:')) {
    renderCrumbs([
      { label: 'Öğrenciler', hash: '#/students', from: 'students' },
      { label: result.name, hash: `#/student/${stuId}`, from: 'students' },
      { label: quiz?.title || 'Quiz' }
    ]);
  } else if (from.startsWith('session:')) {
    renderCrumbs([
      { label: 'Geçmiş Oturumlar', hash: '#/sessions', from: 'sessions' },
      { label: quiz?.title || 'Oturum', hash: `#/session/${sessionId}`, from: 'sessions' },
      { label: result.name }
    ]);
  } else {
    renderCrumbs([
      { label: 'Ana Sayfa', hash: '#/' },
      { label: result.name }
    ]);
  }

  document.getElementById('qaName').textContent = result.name;
  document.getElementById('qaMeta').textContent =
    `${result.sinif || '-'} · ${quiz?.title || ''} · ${result.submittedAt ? new Date(result.submittedAt).toLocaleString('tr-TR') : 'devam ediyor'}`;
  document.getElementById('qaScore').textContent = result.totalScore || 0;

  const wrap = document.getElementById('answersList');
  wrap.innerHTML = '';

  // Quiz'in kendi sırasında soruları göster
  quiz.questions.forEach((q, idx) => {
    const answer = (result.answers || []).find(a => a.questionId === q.id);
    const row = buildAnswerRow(q, answer, idx, result.grading?.[q.id]);
    wrap.appendChild(row);
  });

  // Tek-açık accordion + grading var olanları toggle olsun
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.ans-toggle');
    if (!btn) return;
    if (e.target.closest('.ans-grade')) return; // input click yutma
    if (e.target.tagName === 'INPUT') return;
    const wasOpen = btn.getAttribute('aria-expanded') === 'true';
    // Tek-açık: önce hepsini kapat
    wrap.querySelectorAll('.ans-toggle').forEach(b => {
      b.setAttribute('aria-expanded', 'false');
      b.parentElement.querySelector('.ans-detail').hidden = true;
    });
    if (!wasOpen) {
      btn.setAttribute('aria-expanded', 'true');
      btn.parentElement.querySelector('.ans-detail').hidden = false;
    }
  });

  document.getElementById('expandAll').onclick = () => {
    wrap.querySelectorAll('.ans-toggle').forEach(b => {
      b.setAttribute('aria-expanded', 'true');
      b.parentElement.querySelector('.ans-detail').hidden = false;
    });
  };
  document.getElementById('collapseAll').onclick = () => {
    wrap.querySelectorAll('.ans-toggle').forEach(b => {
      b.setAttribute('aria-expanded', 'false');
      b.parentElement.querySelector('.ans-detail').hidden = true;
    });
  };

  document.getElementById('saveGrading').onclick = async () => {
    const grades = [];
    wrap.querySelectorAll('.ans-row[data-type="open_ended"]').forEach(row => {
      const qid = row.dataset.qid;
      const input = row.querySelector('.grade-input');
      const note = row.querySelector('.grade-note');
      if (!input) return;
      const v = input.value === '' ? null : Number(input.value);
      if (v === null || isNaN(v)) return;
      grades.push({ questionId: qid, manualScore: v, note: note?.value || '' });
    });
    if (!grades.length) {
      showToast('Puanlanacak açık uçlu cevap yok', 'warn');
      return;
    }
    try {
      await api(`/api/admin/results/${result.id}/grade`, { method: 'POST', body: { grades } });
      showToast('Puanlama kaydedildi', 'good');
      renderQADetail(stuId, sessionId);
    } catch (err) { showToast(err.message, 'bad'); }
  };
}

function buildAnswerRow(q, answer, idx, grading) {
  const row = document.createElement('div');
  row.className = 'ans-row';
  row.dataset.type = q.type;
  row.dataset.qid = q.id;

  // Status hesapla
  let status = 'empty';
  let badge = '';
  let givenHTML = '<span class="ans-given empty">(boş)</span>';
  let pointsLabel = `0/${q.points || 1}`;
  let detailHTML = '';

  if (q.type === 'multiple_choice') {
    if (answer && answer.value != null) {
      const idxA = Number(answer.value);
      const correctIdx = q.correctIndex;
      const letter = String.fromCharCode(65 + idxA);
      givenHTML = `<span class="ans-given"><b>${letter})</b> ${escapeHtml(q.options[idxA] || '')}</span>`;
      if (idxA === correctIdx) {
        status = 'correct';
        badge = '<span class="badge good">Doğru</span>';
        pointsLabel = `${q.points || 1}/${q.points || 1}`;
      } else {
        status = 'wrong';
        badge = '<span class="badge bad">Yanlış</span>';
      }
    } else {
      badge = '<span class="badge">Boş</span>';
    }
    // detail: tüm şıklar
    detailHTML = '<ul class="opt-display">';
    q.options.forEach((opt, i) => {
      const isCorrect = i === q.correctIndex;
      const isPicked = answer && Number(answer.value) === i;
      const cls = isCorrect ? 'correct' : (isPicked ? 'wrong' : '');
      const letter = String.fromCharCode(65 + i);
      detailHTML += `<li class="${cls}">${letter}) ${escapeHtml(opt)} ${isCorrect ? '✓' : ''} ${isPicked && !isCorrect ? '← seçim' : ''}</li>`;
    });
    detailHTML += '</ul>';

  } else if (q.type === 'true_false') {
    if (answer && answer.value != null) {
      const picked = String(answer.value) === 'true';
      const correct = q.correctBool === true;
      givenHTML = `<span class="ans-given">${picked ? 'Doğru' : 'Yanlış'}</span>`;
      if (picked === correct) {
        status = 'correct';
        badge = '<span class="badge good">Doğru</span>';
        pointsLabel = `${q.points || 1}/${q.points || 1}`;
      } else {
        status = 'wrong';
        badge = '<span class="badge bad">Yanlış</span>';
      }
    } else {
      badge = '<span class="badge">Boş</span>';
    }
    detailHTML = `<div class="kv"><span class="muted">Doğru cevap:</span> <b>${q.correctBool ? 'Doğru' : 'Yanlış'}</b></div>`;

  } else if (q.type === 'open_ended') {
    const text = answer ? (answer.value || '') : '';
    const truncated = text.length > 50 ? text.slice(0, 50) + '…' : text;
    givenHTML = text
      ? `<span class="ans-given">${escapeHtml(truncated)}</span>`
      : `<span class="ans-given empty">(boş)</span>`;

    if (grading) {
      status = 'correct';
      const total = q.points || 1;
      const got = grading.manualScore || 0;
      badge = got >= total
        ? '<span class="badge good">Puanlandı</span>'
        : got > 0
          ? '<span class="badge warn">Kısmi</span>'
          : '<span class="badge bad">0 puan</span>';
      pointsLabel = `${got}/${total}`;
    } else {
      status = 'pending';
      badge = '<span class="badge warn">Bekliyor</span>';
    }

    detailHTML = `
      <div class="answer-box">${text ? escapeHtml(text) : '<span class="muted">(boş)</span>'}</div>
      <label class="small muted">Öğretmen notu (öğrenci görmez)</label>
      <textarea class="grade-note" placeholder="Notunu yaz...">${escapeAttr(grading?.note || '')}</textarea>
    `;
  }

  row.dataset.status = status;

  // Açık uçlu için satıra inline puan input
  let gradeCol = `<span class="ans-points">${pointsLabel}</span>`;
  if (q.type === 'open_ended') {
    gradeCol = `<span class="ans-grade">
      <input type="number" class="grade-input" min="0" max="${q.points || 1}" placeholder="-" value="${grading?.manualScore ?? ''}" />
      <span class="ans-points-max">/${q.points || 1}</span>
    </span>`;
  }

  row.innerHTML = `
    <button class="ans-toggle" aria-expanded="false">
      <span class="ans-idx">${idx + 1}</span>
      <span class="ans-q" title="${escapeAttr(q.text)}">${escapeHtml(q.text)}</span>
      ${givenHTML}
      ${badge}
      ${gradeCol}
      <span class="ans-chev">▾</span>
    </button>
    <div class="ans-detail" hidden>${detailHTML}</div>
  `;

  // Açık uçlu için puan input'una tıklamayı durdur (accordion açmasın)
  const gi = row.querySelector('.grade-input');
  if (gi) {
    gi.addEventListener('click', e => e.stopPropagation());
    gi.addEventListener('focus', e => e.stopPropagation());
  }

  return row;
}

// Legacy /result/:id → yeni route'a redirect
async function redirectLegacyResult(resultId) {
  try {
    const data = await api(`/api/admin/results/${resultId}`);
    // Yeni: önce studentId, yoksa base64
    const stuId = data.result.studentId || encodeStuId(data.result.name, data.result.sinif);
    location.replace(`#/student/${stuId}/session/${data.result.sessionId}`);
  } catch (e) {
    location.replace('#/');
  }
}

// ============================================================
//  QUIZ SİL MODAL (puanları da sileyim mi?)
// ============================================================
async function showDeleteQuizModal(quiz) {
  let impact;
  try {
    impact = await api(`/api/admin/quizzes/${quiz.id}/delete-impact`);
  } catch (e) {
    showToast(e.message, 'bad');
    return;
  }
  const frag = tplClone('tpl-delete-quiz-modal');
  document.body.appendChild(frag);
  const backdrop = document.body.lastElementChild;
  backdrop.querySelector('#dqTitle').textContent = `"${impact.quizTitle}" silinsin mi?`;
  backdrop.querySelector('#dqImpact').textContent =
    impact.results > 0
      ? `Bu quizden ${impact.sessions} oturum ve ${impact.results} öğrenci sonucu var.`
      : `Bu quizden ${impact.sessions} oturum var, henüz öğrenci sonucu yok.`;

  // Eğer öğrenci sonucu yoksa "Puanları sakla" mantıksız — gizle
  if (impact.results === 0) {
    backdrop.querySelector('#dqKeep').classList.add('hidden');
    backdrop.querySelector('#dqWipe').textContent = 'Sil';
  }

  const close = () => backdrop.remove();
  backdrop.querySelector('#dqCancel').onclick = close;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  async function doDelete(deleteResults) {
    try {
      await api(`/api/admin/quizzes/${quiz.id}?deleteResults=${deleteResults}`, { method: 'DELETE' });
      close();
      showToast(
        deleteResults
          ? `"${quiz.title}" ve ${impact.results} öğrenci sonucu silindi`
          : `"${quiz.title}" silindi, ${impact.results} öğrenci sonucu korundu`,
        'good', 3500
      );
      navigate();
    } catch (err) { showToast(err.message, 'bad'); }
  }
  backdrop.querySelector('#dqKeep').onclick = () => doDelete(false);
  backdrop.querySelector('#dqWipe').onclick = () => doDelete(true);
}

// ============================================================
//  QUIZ BAŞLAT MODAL (hibrit toggle)
// ============================================================
function showStartQuizModal(quiz) {
  const frag = tplClone('tpl-start-quiz-modal');
  document.body.appendChild(frag);
  const backdrop = document.body.lastElementChild;
  backdrop.querySelector('#smQuizTitle').textContent = `"${quiz.title}" başlatılsın mı?`;
  const close = () => backdrop.remove();
  backdrop.querySelector('#smCancel').onclick = close;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#smStart').onclick = async () => {
    const acceptNew = backdrop.querySelector('#smAcceptReg').checked;
    try {
      await api('/api/admin/sessions/start', {
        method: 'POST',
        body: { quizId: quiz.id, kind: 'quiz', acceptNewRegistrations: acceptNew }
      });
      close();
      showToast(`"${quiz.title}" başlatıldı`, 'good');
      location.hash = '#/';
      setTimeout(navigate, 50);
    } catch (e) { showToast(e.message, 'bad'); }
  };
}

// ============================================================
//  KAYIT OTURUMU (#/registration)
// ============================================================
let regSessionInterval = null;
async function renderRegistration() {
  if (regSessionInterval) clearInterval(regSessionInterval);
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-registration'));
  renderCrumbs([{ label: 'Ana Sayfa', hash: '#/' }, { label: 'Kayıt Oturumu' }]);

  async function refresh() {
    const state = await api('/api/admin/state');
    if (!state.activeSession || state.activeSession.kind !== 'registration') {
      clearInterval(regSessionInterval);
      location.hash = '#/';
      return;
    }
    const s = state.activeSession;
    document.getElementById('regCode').textContent = s.code;
    document.getElementById('regQr').src = s.meta.qrDataUrl;
    document.getElementById('regUrls').innerHTML = 'Öğrenci adresi: <strong>' + escapeHtml(s.meta.joinUrl) + '</strong>';

    // Canlı kayıt akışı: tüm öğrencileri çek, createdBy=registration olanları sırala
    const students = await api('/api/admin/students-list');
    const recents = students
      .filter(st => st.createdAt >= s.startedAt)
      .sort((a, b) => b.createdAt - a.createdAt);
    document.getElementById('regCount').textContent = `${recents.length} yeni kayıt`;
    document.getElementById('regUpdated').textContent = 'Son güncelleme: ' + new Date().toLocaleTimeString('tr-TR');

    const feed = document.getElementById('regFeed');
    feed.innerHTML = '';
    if (!recents.length) {
      feed.innerHTML = '<li class="muted small" style="padding:14px;text-align:center;background:transparent;">Henüz kayıt yok. Öğrenciler QR\'ı okutsun.</li>';
    } else {
      // 'new' animasyonu sadece son 5 saniyede kaydolanlar için (yenilenmede sürekli flash olmasın)
      const now = Date.now();
      recents.forEach((st) => {
        const li = document.createElement('li');
        const isFresh = (now - st.createdAt) < 5000;
        li.className = 'reg-row' + (isFresh ? ' new' : '');
        const initials = (st.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
        li.innerHTML = `
          <span class="reg-avatar">${initials}</span>
          <div class="reg-meta">
            <strong>${escapeHtml(st.name)}</strong>
            <span class="muted small">${escapeHtml(st.sinif || '-')} · ${new Date(st.createdAt).toLocaleTimeString('tr-TR')}</span>
          </div>
          <span class="reg-num">${st.id}</span>
        `;
        feed.appendChild(li);
      });
    }

    document.getElementById('endRegBtn').onclick = async () => {
      try {
        await api(`/api/admin/sessions/${s.id}/end`, { method: 'POST' });
        showToast('Kayıt oturumu kapatıldı', 'good');
        clearInterval(regSessionInterval);
        location.hash = '#/';
      } catch (err) { showToast(err.message, 'bad'); }
    };
  }
  await refresh();
  regSessionInterval = setInterval(refresh, 3000);
  socket.on('student:registered', refresh);
}

// ============================================================
//  LOGLAR (#/logs)
// ============================================================
async function renderLogs() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-logs'));

  let allLogs = [];
  async function load() {
    const data = await api('/api/admin/logs');
    allLogs = data.logs;
    render();
  }
  function render() {
    const levelFilter = document.getElementById('logFilter').value;
    const srcFilter = document.getElementById('logSource').value;
    const filtered = allLogs.filter(l =>
      (!levelFilter || l.level === levelFilter) &&
      (!srcFilter || l.source === srcFilter)
    );
    const list = document.getElementById('logList');
    if (!filtered.length) {
      list.innerHTML = '<p class="muted center" style="padding:24px;">Bu filtreyle log yok.</p>';
      return;
    }
    list.innerHTML = '';
    filtered.forEach(l => {
      const row = document.createElement('div');
      row.className = 'log-row ' + l.level;
      const time = new Date(l.ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const ctxStr = Object.keys(l.context || {}).length
        ? JSON.stringify(l.context, null, 2)
        : '';
      // Bulgu 2: level CSS class olarak kullanılırken whitelist; source da escape
      const levelClass = ['info','warn','error','debug'].includes(l.level) ? l.level : 'info';
      row.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-level ${levelClass}">${escapeHtml(l.level)}</span>
        <span class="log-source">${escapeHtml(l.source)}</span>
        <div>
          <div class="log-msg">${escapeHtml(l.message)}</div>
          ${ctxStr ? `<pre class="log-ctx">${escapeHtml(ctxStr)}</pre>` : ''}
        </div>
      `;
      if (ctxStr) {
        row.style.cursor = 'pointer';
        row.onclick = () => row.classList.toggle('expanded');
      }
      list.appendChild(row);
    });
  }
  document.getElementById('logFilter').onchange = render;
  document.getElementById('logSource').onchange = render;
  document.getElementById('logRefresh').onclick = load;
  document.getElementById('logClear').onclick = async () => {
    try {
      await api('/api/admin/logs', { method: 'DELETE' });
      showToast('Tüm loglar silindi', 'good');
      load();
    } catch (e) { showToast(e.message, 'bad'); }
  };
  load();
}

// ============================================================
//  AYARLAR (theme picker + custom color)
// ============================================================
function renderSettings() {
  app.innerHTML = '';
  app.appendChild(tplClone('tpl-settings'));

  // Preset kartları
  const presets = [
    { id: 'krem',        label: 'Krem & Turkuaz', bg: 'linear-gradient(160deg,#f7efde,#e2eee9)', panel: '#ffffff',  accent: '#4fb3a8', text: '#2d3142' },
    { id: 'dark-purple', label: 'Koyu Mor',       bg: 'linear-gradient(160deg,#0f172a,#1e1b4b)', panel: '#1e293b',  accent: '#6366f1', text: '#f1f5f9' },
    { id: 'dark-blue',   label: 'Koyu Mavi',      bg: 'linear-gradient(160deg,#0b1220,#0c2a4a)', panel: '#0f2540',  accent: '#3b82f6', text: '#e6efff' },
    { id: 'dark-green',  label: 'Koyu Yeşil',     bg: 'linear-gradient(160deg,#08130d,#0f2a1c)', panel: '#11281d',  accent: '#10b981', text: '#e8f5ec' },
    { id: 'light',       label: 'Beyaz Sade',     bg: 'linear-gradient(160deg,#f8fafc,#eef2ff)', panel: '#ffffff',  accent: '#6366f1', text: '#0f172a' },
    { id: 'pastel',      label: 'Pastel',         bg: 'linear-gradient(160deg,#fff7f5,#f0f5ff)', panel: '#ffffff',  accent: '#ec4899', text: '#3b2a4a' },
    { id: 'hc',          label: 'Y. Kontrast',    bg: '#000', panel: '#000', accent: '#ffd400', text: '#fff' }
  ];

  const grid = document.getElementById('themeGrid');
  const cur = Theme.current();

  presets.forEach(p => {
    const card = document.createElement('button');
    card.className = 'theme-card' + (cur === p.id ? ' active' : '');
    card.dataset.theme = p.id;
    card.style.cssText = `--p-bg:${p.bg};--p-panel:${p.panel};--p-accent:${p.accent};--p-text:${p.text};`;
    card.innerHTML = `
      <div class="tc-preview">
        <div class="tc-bar"></div>
        <div class="tc-card">
          <div class="tc-line"></div>
          <div class="tc-line short"></div>
          <div class="tc-btn">Aa</div>
        </div>
      </div>
      <div class="tc-label">
        <strong>${p.label}</strong>
        <span class="tc-check">✓</span>
      </div>
    `;
    card.addEventListener('click', () => {
      Theme.apply(p.id);
      grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
    grid.appendChild(card);
  });

  // Custom picker — mevcut tema renklerini başlangıç değer olarak doldur
  const css = getComputedStyle(document.documentElement);
  const initBg1 = rgbToHex(css.getPropertyValue('--bg-1').trim()) || '#f7efde';
  const initBg2 = rgbToHex(css.getPropertyValue('--bg-2').trim()) || '#e2eee9';
  const initPanel = rgbToHex(css.getPropertyValue('--panel').trim()) || '#ffffff';
  const initAccent = rgbToHex(css.getPropertyValue('--accent').trim()) || '#4fb3a8';
  const initText = rgbToHex(css.getPropertyValue('--text').trim()) || '#2d3142';

  document.getElementById('cBg1').value = initBg1;
  document.getElementById('cBg2').value = initBg2;
  document.getElementById('cPanel').value = initPanel;
  document.getElementById('cAccent').value = initAccent;
  document.getElementById('cText').value = initText;

  document.getElementById('applyCustom').onclick = () => {
    Theme.apply('custom', {
      '--bg-1':   document.getElementById('cBg1').value,
      '--bg-2':   document.getElementById('cBg2').value,
      '--panel':  document.getElementById('cPanel').value,
      '--panel-2': document.getElementById('cPanel').value,
      '--accent': document.getElementById('cAccent').value,
      '--accent-2': document.getElementById('cAccent').value,
      '--text':   document.getElementById('cText').value
    });
    grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
  };
  document.getElementById('resetCustom').onclick = () => {
    Theme.apply('krem');
    renderSettings();
  };
}

function rgbToHex(value) {
  if (!value) return null;
  if (value.startsWith('#')) return value;
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

// ============================================================
//  Utilities
// ============================================================
function encodeStuId(name, sinif) {
  const key = (name || '').toLowerCase().trim() + '|' + (sinif || '').toLowerCase().trim();
  // base64url
  return btoa(unescape(encodeURIComponent(key)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function statusBadge(status) {
  return {
    in_progress: '<span class="badge">Çözüyor</span>',
    submitted: '<span class="badge good">Teslim Edildi</span>',
    awaiting_grading: '<span class="badge warn">Puanlama bekliyor</span>',
    graded: '<span class="badge good">Puanlandı</span>'
  }[status] || `<span class="badge">${status}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ============================================================
//  Canlı güncellemeler
// ============================================================
let dashboardRefreshTimer = null;
function maybeRefreshDashboard() {
  if ((location.hash || '#/') === '#/' || !location.hash) {
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = setTimeout(() => navigate(), 300);
  }
}
socket.on('student:joined', maybeRefreshDashboard);
socket.on('student:submitted', maybeRefreshDashboard);

// Client-side global hata yakalayıcı — sadece beklenmedik JS hatalarını rapor et
// (API HTTP hataları zaten kullanıcıya alert ile gösteriliyor, logging'e boğmasın)
function reportClientError(message, context) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'error', source: 'client',
        message: String(message || 'bilinmeyen tarayıcı hatası'),
        context: { url: location.href, ...(context || {}) }
      })
    }).catch(() => {});
  } catch (e) {}
}
window.addEventListener('error', e => {
  if (!e.filename || e.filename.indexOf(location.origin) < 0) return;
  reportClientError('Yönetim panelinde JavaScript hatası: ' + e.message, {
    filename: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack?.slice(0, 500)
  });
});
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  // API hatalarını skip — kullanıcıya zaten gösteriliyor
  if (reason?.silent || (reason?.status >= 400 && reason?.status < 500)) return;
  reportClientError('Yönetim panelinde yakalanmamış async hata: ' + (reason?.message || reason),
    { stack: reason?.stack?.slice(0, 500) });
});

// İlk yükleme
navigate();
