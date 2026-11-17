import { firebaseConfig, VISUAL_MONTHS, WORKSHOP_MONTHS, DEFAULT_RADIUS_M } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, collection, query, where, orderBy, limit, writeBatch, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ---------- أدوات عامة ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => (d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '—');
const fmtDT = (d) => (d ? `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—');
const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null);

function addMonths(d, m) {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + m);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, last));
  return r;
}

const ROLE_LABELS = {
  officer: 'مسؤول دفاع مدني / سلامة',
  specialist: 'أخصائي سلامة',
  manager: 'مدير سلامة',
  director: 'مدير عام السلامة'
};
const SUPERVISORS = ['specialist', 'manager', 'director'];
const ADMINS = ['manager', 'director'];

const STATUS_CLASS = {
  'سليمة': 's-ok', 'متأخرة': 's-late', 'تحتاج ورشة': 's-bad', 'في الورشة': 's-ws', 'لم تُفحص': 's-none'
};
const STATUSES = ['سليمة', 'متأخرة', 'تحتاج ورشة', 'في الورشة', 'لم تُفحص'];
const chip = (st) => `<span class="chip ${STATUS_CLASS[st] || 's-none'}">${esc(st)}</span>`;

/* الحالة تُحسب من سجل الاطلاع العام (publicStatus) ومدد الدورات */
function statusOf(ps) {
  if (!ps) return 'لم تُفحص';
  if (ps.inWorkshop) return 'في الورشة';
  if (ps.needsWorkshop) return 'تحتاج ورشة';
  const li = ps.lastInspectionAt !== undefined ? toDate(ps.lastInspectionAt) || new Date() : null;
  const lw = ps.lastWorkshopAt !== undefined ? toDate(ps.lastWorkshopAt) || new Date() : null;
  if (!li && !lw) return 'لم تُفحص';
  const now = new Date();
  if (li && addMonths(li, VISUAL_MONTHS) < now) return 'متأخرة';
  if (lw && addMonths(lw, WORKSHOP_MONTHS) < now) return 'متأخرة';
  return 'سليمة';
}
function nextDates(ps) {
  const li = ps && ps.lastInspectionAt !== undefined ? toDate(ps.lastInspectionAt) || new Date() : null;
  const lw = ps && ps.lastWorkshopAt !== undefined ? toDate(ps.lastWorkshopAt) || new Date() : null;
  return { li, lw, visual: li ? addMonths(li, VISUAL_MONTHS) : null, workshop: lw ? addMonths(lw, WORKSHOP_MONTHS) : null };
}

function getPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}
function dist(a, b) {
  const R = 6371000, t = (x) => (x * Math.PI) / 180;
  const dLat = t(b.lat - a.lat), dLng = t(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 4500);
}

/* يعتبر الحفظ ناجحًا لو اتأكد من السيرفر، أو "معلّق" لو مفيش إنترنت (يُرسل تلقائيًا بعدين) */
async function settle(p, ms = 7000) {
  p.catch(() => {});
  let t;
  const timeout = new Promise((r) => { t = setTimeout(() => r('pending'), ms); });
  try {
    return await Promise.race([p.then(() => 'ok'), timeout]);
  } finally {
    clearTimeout(t);
  }
}
function errMsg(e) {
  if (e && e.code === 'permission-denied') return 'غير مسموح: الكود غير صالح أو لا توجد صلاحية.';
  if (e && e.code === 'auth/invalid-credential') return 'البريد أو كلمة المرور غير صحيحة.';
  return 'حدث خطأ: ' + ((e && (e.code || e.message)) || 'غير معروف');
}

function csvDownload(name, rows) {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = rows.map((r) => r.map(q).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function randomToken(n = 22) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => abc[b % abc.length]).join('');
}

/* ---------- التشغيل ---------- */
const EXT = (new URLSearchParams(location.search).get('e') || '').trim();
const TOKEN = (new URLSearchParams(location.search).get('t') || '').trim();
const configured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('PASTE');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

let auth, db;
let user = null, profile = null, ready = false, showLogin = false;
let tab = 'home';
let cleanup = null;
let scanLogged = false;

if (!configured) {
  document.getElementById('app').innerHTML = `
  <header class="top"><div class="brand"><i></i>SafeScan</div></header>
  <main class="wrap"><div class="card"><h2>الإعداد غير مكتمل</h2>
  <p class="muted">افتح ملف config.js والصق بيانات firebaseConfig الخاصة بتطبيق الويب من Firebase مكان كلمات PASTE، ثم احفظ الملف وحدّث الصفحة.</p></div></main>`;
} else {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  try {
    db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = getFirestore(fbApp);
  }
  onAuthStateChanged(auth, async (u) => {
    user = u;
    profile = null;
    if (u) {
      try {
        const s = await getDoc(doc(db, 'users', u.uid));
        profile = s.exists() ? s.data() : null;
      } catch (e) { profile = null; }
    }
    ready = true;
    render();
  });
  render();
}

/* ---------- الهيكل العام ---------- */
function shell(inner, withNav) {
  const isStaff = user && profile;
  const nav = withNav && isStaff
    ? `<nav class="nav">
        <button data-tab="home" class="${tab === 'home' ? 'on' : ''}">الرئيسية</button>
        <button data-tab="scan" class="${tab === 'scan' ? 'on' : ''}">مسح</button>
        <button data-tab="follow" class="${tab === 'follow' ? 'on' : ''}">${SUPERVISORS.includes(profile.role) ? 'المتابعة' : 'سجلاتي'}</button>
        ${ADMINS.includes(profile.role) ? `<button data-tab="admin" class="${tab === 'admin' ? 'on' : ''}">الإدارة</button>` : ''}
      </nav>` : '';
  document.getElementById('app').innerHTML = `
    <header class="top"><div class="brand"><i></i>SafeScan</div>
    <div class="who">${isStaff ? `<span>${esc(profile.name || user.email)}</span>` : ''}${user ? '<button class="lnk" id="out">خروج</button>' : ''}</div></header>
    <main class="wrap">${inner}</main>${nav}<div id="toast" class="toast" hidden></div>`;
  const o = $('#out');
  if (o) o.onclick = () => signOut(auth).then(() => location.reload());
  document.querySelectorAll('.nav button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; render(); };
  });
}

function render() {
  if (!configured) return;
  if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
  if (!ready) {
    shell('<div class="card">جارٍ التحميل…</div>');
    return;
  }
  if (EXT) return viewExt();
  if (!user) return viewLogin();
  if (!profile) {
    shell(`<div class="card"><h2>حسابك غير مفعّل</h2><p class="muted">تم تسجيل الدخول لكن لا يوجد دور مسجّل لهذا الحساب. اطلب من المدير إضافته.</p></div>`);
    return;
  }
  shell('<div id="view"></div>', true);
  if (tab === 'home') viewHome();
  else if (tab === 'scan') viewScan();
  else if (tab === 'follow') viewFollow();
  else if (tab === 'admin' && ADMINS.includes(profile.role)) viewAdmin();
  else viewHome();
}

/* ---------- تسجيل الدخول ---------- */
function loginForm(afterLogin) {
  return `<form id="lf" class="card">
    <h2>دخول الموظفين</h2>
    <label for="em">البريد الإلكتروني</label><input id="em" type="email" autocomplete="username" required>
    <label for="pw">كلمة المرور</label><input id="pw" type="password" autocomplete="current-password" required>
    <div id="lerr"></div>
    <div style="height:12px"></div><button class="btn" id="lgo">دخول</button></form>`;
}
function bindLogin() {
  $('#lf').onsubmit = async (ev) => {
    ev.preventDefault();
    const b = $('#lgo');
    b.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $('#em').value.trim(), $('#pw').value);
    } catch (e) {
      $('#lerr').innerHTML = `<div class="err" style="margin-top:10px">${esc(errMsg(e))}</div>`;
      b.disabled = false;
    }
  };
}
function viewLogin() {
  shell(loginForm());
  bindLogin();
}

/* ---------- صفحة الطفاية (عامة للقراءة + أدوات الموظفين) ---------- */
async function viewExt() {
  if (showLogin && !user) {
    shell(`<div class="card"><div class="muted">الطفاية: <b>${esc(EXT)}</b></div></div>${loginForm()}`);
    bindLogin();
    return;
  }
  shell(`<div class="card" id="extcard">جارٍ التحميل…</div><div id="acts"></div>`);
  let ps = null, failed = false;
  try {
    const s = await getDoc(doc(db, 'publicStatus', EXT));
    ps = s.exists() ? s.data() : null;
  } catch (e) { failed = true; }
  const card = $('#extcard');
  if (!card) return;
  if (failed) {
    card.innerHTML = '<h2>تعذر تحميل البيانات</h2><p class="muted">تحقق من الإنترنت وحاول مرة أخرى.</p>';
    return;
  }
  if (!ps) {
    card.innerHTML = `<h2>طفاية غير مسجلة</h2><p class="muted">الرقم: ${esc(EXT)}</p>`;
    return;
  }
  const st = statusOf(ps);
  const nd = nextDates(ps);
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px">
      <div class="big">${esc(EXT)}</div>${chip(st)}</div>
    <div class="kv"><span>آخر فحص</span><b>${fmtDate(nd.li)}</b></div>
    <div class="kv"><span>نتيجة آخر فحص</span><b>${esc(ps.lastResult || '—')}</b></div>
    <div class="kv"><span>الفحص القادم</span><b>${fmtDate(nd.visual)}</b></div>
    <div class="kv"><span>آخر فحص / تعبئة بالورشة</span><b>${fmtDate(nd.lw)}</b></div>
    <div class="kv"><span>موعد الورشة القادم</span><b>${fmtDate(nd.workshop)}</b></div>
    <p class="muted" style="margin-top:8px">آخر تحديث للبيانات: ${fmtDT(toDate(ps.updatedAt))}. هذه الصفحة للاطلاع فقط.</p>`;

  const acts = $('#acts');
  if (!user || !profile) {
    acts.innerHTML = `<button class="btn alt" id="sl">دخول الموظفين</button>`;
    $('#sl').onclick = () => { showLogin = true; viewExt(); };
    return;
  }
  if (!TOKEN) {
    acts.innerHTML = `<div class="warn">لتسجيل فحص لازم تمسح كود الطفاية بالكاميرا، لأن الكود نفسه هو إثبات وجودك عندها.</div>
      <div style="height:10px"></div><a class="btn alt" href="./">العودة للرئيسية</a>`;
    return;
  }
  acts.innerHTML = `<div id="scanmsg" class="muted"></div><div style="height:8px"></div>
    <button class="btn" id="go">بدء الفحص الشهري</button><div style="height:10px"></div>
    <a class="btn alt" href="./">العودة للرئيسية</a>`;
  $('#go').onclick = () => viewInspect(ps);
  logScan();
}

async function logScan() {
  if (scanLogged) return;
  scanLogged = true;
  const m = $('#scanmsg');
  const pos = await getPos();
  const ref = doc(collection(db, 'scans'));
  const batch = writeBatch(db);
  batch.set(ref, {
    extId: EXT, token: TOKEN, inspectorId: user.uid, inspectorName: profile.name || user.email,
    lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, deviceTime: Timestamp.now(),
    offline: !navigator.onLine, createdAt: serverTimestamp()
  });
  try {
    const r = await settle(batch.commit(), 5000);
    if (m) m.textContent = r === 'ok' ? 'تم تسجيل مسح الكود.' : 'تم حفظ المسح على الجهاز، وسيُرسل عند توفر الإنترنت.';
  } catch (e) {
    if (m) m.innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    const g = $('#go');
    if (g && e && e.code === 'permission-denied') g.disabled = true;
  }
}

/* ---------- نموذج الفحص البصري ---------- */
const ITEMS = [
  ['pressure', 'مؤشر الضغط في المنطقة الخضراء'],
  ['pin', 'مسمار الأمان والختم سليمان'],
  ['hose', 'الخرطوم والفوهة بلا تشقق أو انسداد'],
  ['body', 'الجسم بلا صدأ أو انبعاج'],
  ['place', 'الطفاية في مكانها واللافتة ظاهرة']
];
const REASONS = ['تعبئة', 'ضغط ناقص', 'ختم تالف', 'تلف في الجسم', 'أخرى'];

async function viewInspect() {
  const st = { items: Object.fromEntries(ITEMS.map(([k]) => [k, 'ok'])), reason: '', notes: '', pos: null, ext: null, busy: false };
  const draw = () => {
    const issues = Object.values(st.items).some((v) => v === 'issue');
    $('.wrap').innerHTML = `
      <div class="card"><h2>الفحص البصري الشهري</h2><p class="muted">${esc(EXT)} · ${fmtDate(new Date())}</p>
      <p class="muted" id="gps">${st.pos ? 'تم تحديد موقعك.' : 'جارٍ تحديد الموقع… (اختياري)'}</p></div>
      <div class="card">${ITEMS.map(([k, t]) => `<div class="pick"><div class="t">${t}</div>
        <button class="pb ok ${st.items[k] === 'ok' ? 'on' : ''}" data-k="${k}" data-v="ok">سليم</button>
        <button class="pb bad ${st.items[k] === 'issue' ? 'on' : ''}" data-k="${k}" data-v="issue">ملاحظة</button></div>`).join('')}</div>
      ${issues ? `<div class="card"><h3>سبب الإحالة للورشة</h3>
        <select id="rs"><option value="">اختر السبب</option>${REASONS.map((r) => `<option ${st.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>` : ''}
      <div class="card"><label for="nt">ملاحظات (اختياري)</label><textarea id="nt">${esc(st.notes)}</textarea></div>
      <div id="ierr"></div>
      <button class="btn" id="sv" ${st.busy ? 'disabled' : ''}>حفظ الفحص</button>
      <a class="btn alt" href="./">إلغاء</a>`;
    document.querySelectorAll('.pb').forEach((b) => {
      b.onclick = () => { st.items[b.dataset.k] = b.dataset.v; st.notes = $('#nt').value; draw(); };
    });
    const rs = $('#rs');
    if (rs) rs.onchange = () => (st.reason = rs.value);
    $('#nt').oninput = (e) => (st.notes = e.target.value);
    $('#sv').onclick = save;
  };
  const save = async () => {
    const issues = Object.values(st.items).some((v) => v === 'issue');
    if (issues && !st.reason) { $('#ierr').innerHTML = '<div class="err">اختر سبب الإحالة للورشة.</div>'; return; }
    st.busy = true;
    $('#sv').disabled = true;
    const result = issues ? 'تحتاج ورشة' : 'سليمة';
    let d = null, far = false;
    const ex = st.ext;
    if (st.pos && ex && typeof ex.lat === 'number' && typeof ex.lng === 'number') {
      d = dist(st.pos, ex);
      far = d > (ex.radiusM || DEFAULT_RADIUS_M);
    }
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'inspections')), {
      extId: EXT, token: TOKEN, inspectorId: user.uid, inspectorName: profile.name || user.email,
      items: st.items, result, reason: st.reason || '', notes: st.notes || '',
      lat: st.pos ? st.pos.lat : null, lng: st.pos ? st.pos.lng : null, distanceM: d, farFromLocation: far,
      deviceTime: Timestamp.now(), offline: !navigator.onLine, createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'publicStatus', EXT), {
      extId: EXT, lastInspectionAt: serverTimestamp(), lastResult: result,
      ...(issues ? { needsWorkshop: true } : {}), updatedAt: serverTimestamp()
    }, { merge: true });
    try {
      const r = await settle(batch.commit());
      $('.wrap').innerHTML = `<div class="card"><h2>${r === 'ok' ? 'تم حفظ الفحص' : 'تم حفظ الفحص على الجهاز'}</h2>
        <p class="muted">${r === 'ok' ? 'سُجّل الفحص بوقت السيرفر.' : 'لا يوجد اتصال الآن، وسيُرسل الفحص تلقائيًا عند توفر الإنترنت.'}</p>
        <div style="height:10px"></div>${chip(result)}
        ${far ? `<div class="warn" style="margin-top:12px">موقعك بعيد عن موقع الطفاية المسجل (${d} متر)، وسيُعلَّم الفحص للمشرف.</div>` : ''}</div>
        <a class="btn" href="./">العودة للرئيسية</a>`;
    } catch (e) {
      st.busy = false;
      draw();
      $('#ierr').innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    }
  };
  draw();
  getDoc(doc(db, 'extinguishers', EXT)).then((s) => { st.ext = s.exists() ? s.data() : null; }).catch(() => {});
  getPos().then((p) => { st.pos = p; const g = $('#gps'); if (g) g.textContent = p ? 'تم تحديد موقعك.' : 'تعذر تحديد الموقع، وسيُعلَّم الفحص للمشرف.'; });
}

/* ---------- الرئيسية ---------- */
async function viewHome() {
  const v = $('#view');
  v.innerHTML = '<div class="card">جارٍ التحميل…</div>';
  let es, pss;
  try {
    [es, pss] = await Promise.all([getDocs(collection(db, 'extinguishers')), getDocs(collection(db, 'publicStatus'))]);
  } catch (e) {
    v.innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    return;
  }
  const pmap = {};
  pss.forEach((d) => (pmap[d.id] = d.data()));
  const rows = [];
  es.forEach((d) => { const e = d.data(); rows.push({ id: d.id, e, p: pmap[d.id], st: statusOf(pmap[d.id]) }); });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  let filter = 'all', q = '';
  const counts = {};
  STATUSES.forEach((s) => (counts[s] = rows.filter((r) => r.st === s).length));
  const branches = {};
  rows.forEach((r) => {
    const b = r.e.branch || '—';
    branches[b] = branches[b] || { total: 0 };
    branches[b].total++;
    branches[b][r.st] = (branches[b][r.st] || 0) + 1;
  });
  const loc = (e) => [e.building, e.floor, e.area].filter(Boolean).join(' - ') || '—';
  const draw = () => {
    const list = rows.filter((r) => (filter === 'all' || r.st === filter) && (!q || (r.id + ' ' + loc(r.e)).toLowerCase().includes(q.toLowerCase())));
    v.innerHTML = `
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="muted">إجمالي الطفايات</span><span class="big">${rows.length}</span></div></div>
      <div class="grid">${STATUSES.map((s) => `<div class="stat ${filter === s ? 'on' : ''}" data-f="${s}"><b>${counts[s]}</b><span>${s}</span></div>`).join('')}</div>
      <div class="card"><input id="q" placeholder="بحث برقم الطفاية أو الموقع" value="${esc(q)}">
      <div style="height:6px"></div>${list.length ? list.map((r) => `<div class="item" data-id="${esc(r.id)}"><div><b>${esc(r.id)}</b><small>${esc(r.e.branch || '')} ${esc(loc(r.e))}</small></div>${chip(r.st)}</div>`).join('') : '<p class="muted">لا توجد طفايات.</p>'}</div>
      <div class="card"><h3>الحصر حسب الفرع</h3><div class="scroll"><table class="tbl"><tr><th>الفرع</th><th>الإجمالي</th>${STATUSES.map((s) => `<th>${s}</th>`).join('')}</tr>
        ${Object.entries(branches).map(([b, c]) => `<tr><td>${esc(b)}</td><td>${c.total}</td>${STATUSES.map((s) => `<td>${c[s] || 0}</td>`).join('')}</tr>`).join('')}</table></div>
        <div style="height:10px"></div><button class="btn alt" id="csv">تصدير الحصر (Excel)</button></div>
      ${deferredInstall ? '<button class="btn alt" id="inst">تثبيت التطبيق على الشاشة</button>' : ''}`;
    document.querySelectorAll('.stat').forEach((s) => (s.onclick = () => { filter = filter === s.dataset.f ? 'all' : s.dataset.f; draw(); }));
    document.querySelectorAll('.item').forEach((i) => (i.onclick = () => (location.href = '?e=' + encodeURIComponent(i.dataset.id))));
    const qi = $('#q');
    qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; draw(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
    $('#csv').onclick = () => {
      const head = ['رقم الطفاية', 'الرقم التسلسلي', 'الشركة المصنعة', 'النوع', 'السعة', 'الفرع', 'المبنى', 'الدور', 'المنطقة', 'تاريخ التصنيع', 'الحالة', 'آخر فحص', 'الفحص القادم', 'آخر ورشة', 'موعد الورشة القادم'];
      const body = rows.map((r) => { const n = nextDates(r.p); return [r.id, r.e.serial, r.e.manufacturer, r.e.type, r.e.capacity, r.e.branch, r.e.building, r.e.floor, r.e.area, r.e.mfgDate, r.st, fmtDate(n.li), fmtDate(n.visual), fmtDate(n.lw), fmtDate(n.workshop)]; });
      csvDownload('safescan-inventory.csv', [head, ...body]);
    };
    const ib = $('#inst');
    if (ib) ib.onclick = () => deferredInstall.prompt();
  };
  draw();
}

/* ---------- مسح الكود بالكاميرا ---------- */
async function viewScan() {
  const v = $('#view');
  const ok = 'BarcodeDetector' in window;
  v.innerHTML = `<div class="card"><h2>مسح الكود</h2>
    <p class="muted">أسهل طريقة: افتح كاميرا الموبايل العادية ووجّهها نحو الكود، وسيفتح الرابط هنا مباشرة.</p>
    ${ok ? '<video id="cam" class="cam" playsinline muted></video><button class="btn alt" id="stop">إيقاف الكاميرا</button>' : '<p class="muted" style="margin-top:8px">المسح من داخل التطبيق غير مدعوم في هذا المتصفح، استخدم كاميرا الموبايل.</p>'}</div>`;
  if (!ok) return;
  let stream, stopped = false;
  const stop = () => { stopped = true; if (stream) stream.getTracks().forEach((t) => t.stop()); };
  cleanup = stop;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) { toast('تعذر فتح الكاميرا. اسمح للمتصفح باستخدامها.'); return; }
  const vid = $('#cam');
  if (!vid) { stop(); return; }
  vid.srcObject = stream;
  try { await vid.play(); } catch (e) {}
  $('#stop').onclick = stop;
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  while (!stopped) {
    try {
      const r = await det.detect(vid);
      if (r.length) {
        const u = new URL(r[0].rawValue);
        if (u.origin === location.origin && u.searchParams.get('e')) { stop(); location.href = u.href; return; }
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 350));
  }
}

/* ---------- المتابعة / سجلاتي ---------- */
async function viewFollow() {
  const v = $('#view');
  const sup = SUPERVISORS.includes(profile.role);
  v.innerHTML = '<div class="card">جارٍ التحميل…</div>';
  let ins = [], scs = [];
  try {
    const qi = sup ? query(collection(db, 'inspections'), orderBy('createdAt', 'desc'), limit(40))
      : query(collection(db, 'inspections'), where('inspectorId', '==', user.uid), limit(40));
    const qs2 = sup ? query(collection(db, 'scans'), orderBy('createdAt', 'desc'), limit(40))
      : query(collection(db, 'scans'), where('inspectorId', '==', user.uid), limit(40));
    const [a, b] = await Promise.all([getDocs(qi), getDocs(qs2)]);
    a.forEach((d) => ins.push(d.data()));
    b.forEach((d) => scs.push(d.data()));
  } catch (e) {
    v.innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    return;
  }
  const ts = (x) => toDate(x.createdAt) || toDate(x.deviceTime) || new Date(0);
  ins.sort((x, y) => ts(y) - ts(x));
  scs.sort((x, y) => ts(y) - ts(x));
  const flags = (x) => [
    x.farFromLocation ? `بعيد عن الموقع (${x.distanceM} م)` : '',
    x.lat == null && x.lng == null ? 'بدون موقع' : '',
    x.offline ? 'سُجل بدون إنترنت' : ''
  ].filter(Boolean).join(' · ');
  const noInspection = (s) => !ins.some((i) => i.extId === s.extId && i.inspectorId === s.inspectorId && ts(i) >= ts(s));
  v.innerHTML = `
    ${sup ? '<button class="btn alt" id="wk">تسجيل زيارة ورشة</button>' : ''}
    <div class="card"><h2>آخر الفحوصات</h2>${ins.length ? ins.map((x) => `<div class="item" style="cursor:default"><div><b>${esc(x.extId)}</b><small>${fmtDT(ts(x))} · ${esc(x.inspectorName)}</small>${flags(x) ? `<small style="color:#8A5A00">${esc(flags(x))}</small>` : ''}</div>${chip(x.result)}</div>`).join('') : '<p class="muted">لا توجد فحوصات.</p>'}</div>
    <div class="card"><h2>آخر عمليات المسح</h2>${scs.length ? scs.map((x) => `<div class="item" style="cursor:default"><div><b>${esc(x.extId)}</b><small>${fmtDT(ts(x))} · ${esc(x.inspectorName)}</small>${flags(x) ? `<small style="color:#8A5A00">${esc(flags(x))}</small>` : ''}</div>${noInspection(x) ? '<span class="chip s-late">دخول بدون فحص</span>' : '<span class="chip s-ok">تم الفحص</span>'}</div>`).join('') : '<p class="muted">لا توجد عمليات مسح.</p>'}</div>`;
  const wk = $('#wk');
  if (wk) wk.onclick = viewWorkshop;
}

/* ---------- تسجيل الورشة (للأخصائي فما فوق) ---------- */
function viewWorkshop() {
  const v = $('#view');
  const today = new Date().toISOString().slice(0, 10);
  v.innerHTML = `<div class="card"><h2>تسجيل زيارة ورشة</h2>
    <label for="wx">رقم الطفاية</label><input id="wx" value="${esc(EXT)}">
    <label for="wt">نوع العمل</label><select id="wt"><option>فحص + تعبئة</option><option>فحص</option><option>تعبئة</option><option>صيانة</option></select>
    <label for="wn">الورشة</label><input id="wn">
    <div class="row"><div><label for="wr">تاريخ الاستلام</label><input id="wr" type="date" value="${today}"></div>
    <div><label for="wd">تاريخ التسليم</label><input id="wd" type="date"></div></div>
    <label for="wres">نتيجة الفحص</label><select id="wres"><option>سليمة</option><option>تحتاج قطع</option><option>مستبعدة</option></select>
    <div class="row"><div><label for="wm">مادة التعبئة</label><input id="wm"></div><div><label for="wq">الكمية</label><input id="wq"></div></div>
    <label for="wc">رقم شهادة الورشة</label><input id="wc">
    <label for="wnote">ملاحظات</label><textarea id="wnote"></textarea>
    <p class="muted">اترك تاريخ التسليم فارغًا لو الطفاية ما رجعتش من الورشة بعد.</p>
    <div id="werr"></div><div style="height:10px"></div><button class="btn" id="wsv">حفظ</button>
    <div style="height:8px"></div><button class="btn alt" id="wcx">رجوع</button></div>`;
  $('#wcx').onclick = viewFollow;
  $('#wsv').onclick = async () => {
    const id = $('#wx').value.trim();
    if (!id || !$('#wn').value.trim() || !$('#wr').value) { $('#werr').innerHTML = '<div class="err">اكتب رقم الطفاية واسم الورشة وتاريخ الاستلام.</div>'; return; }
    const delivered = $('#wd').value;
    const result = $('#wres').value;
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'workshopLogs')), {
      extId: id, workType: $('#wt').value, workshop: $('#wn').value.trim(), receivedAt: $('#wr').value, deliveredAt: delivered || '',
      result, material: $('#wm').value.trim(), qty: $('#wq').value.trim(), cert: $('#wc').value.trim(), notes: $('#wnote').value.trim(),
      byId: user.uid, byName: profile.name || user.email, createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'publicStatus', id), {
      extId: id, inWorkshop: !delivered, needsWorkshop: delivered ? result !== 'سليمة' : false,
      ...(delivered ? { lastWorkshopAt: serverTimestamp() } : {}), updatedAt: serverTimestamp()
    }, { merge: true });
    $('#wsv').disabled = true;
    try {
      const r = await settle(batch.commit());
      toast(r === 'ok' ? 'تم حفظ سجل الورشة.' : 'تم الحفظ على الجهاز، وسيُرسل عند توفر الإنترنت.');
      viewFollow();
    } catch (e) {
      $('#wsv').disabled = false;
      $('#werr').innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    }
  };
}

/* ---------- الإدارة: تسجيل طفاية وطباعة ملصق QR ---------- */
function viewAdmin() {
  const v = $('#view');
  const st = { pos: null };
  v.innerHTML = `<div class="card"><h2>تسجيل طفاية جديدة</h2>
    <label for="aid">رقم الطفاية (الباركود)</label>
    <div style="display:flex;gap:8px"><input id="aid" placeholder="مثال: FE-0001"><button class="btn alt" id="agen" style="width:auto">توليد</button></div>
    <div class="row"><div><label for="asn">الرقم التسلسلي</label><input id="asn"></div><div><label for="amf">الشركة المصنعة</label><input id="amf"></div></div>
    <div class="row"><div><label for="aty">النوع</label><select id="aty"><option>بودرة</option><option>CO₂</option><option>رغوة</option><option>مياه</option></select></div>
    <div><label for="acp">الوزن / السعة (كجم)</label><input id="acp" inputmode="decimal"></div></div>
    <label for="abr">الفرع</label><input id="abr" value="الفرع 1">
    <div class="row"><div><label for="abl">المبنى</label><input id="abl"></div><div><label for="afl">الدور</label><input id="afl"></div></div>
    <label for="aar">المنطقة</label><input id="aar">
    <label for="amd">تاريخ التصنيع</label><input id="amd" type="date">
    <button class="btn alt" id="agps" style="margin-top:12px">تسجيل موقعي الحالي كموقع الطفاية</button>
    <p class="muted" id="agpst">وأنت واقف بجانب الطفاية، اضغط الزر لحفظ موقعها (اختياري، لكنه يفعّل تنبيه البعد).</p>
    <div id="aerr"></div><div style="height:10px"></div><button class="btn" id="asv">حفظ وإنشاء الكود</button></div><div id="lab"></div>`;
  $('#agen').onclick = () => { $('#aid').value = 'FE-' + Date.now().toString(36).toUpperCase().slice(-5); };
  $('#agps').onclick = async () => {
    $('#agpst').textContent = 'جارٍ تحديد الموقع…';
    st.pos = await getPos();
    $('#agpst').textContent = st.pos ? `تم حفظ الموقع (دقة ${st.pos.acc} متر).` : 'تعذر تحديد الموقع.';
  };
  $('#asv').onclick = async () => {
    const id = $('#aid').value.trim();
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) { $('#aerr').innerHTML = '<div class="err">رقم الطفاية: 3 إلى 40 حرفًا إنجليزيًا أو أرقامًا أو - _ بدون مسافات.</div>'; return; }
    $('#asv').disabled = true;
    try {
      const ex = await getDoc(doc(db, 'extinguishers', id));
      if (ex.exists()) { $('#aerr').innerHTML = '<div class="err">هذا الرقم مسجل من قبل.</div>'; $('#asv').disabled = false; return; }
    } catch (e) { /* offline: نكمل */ }
    const token = randomToken();
    const batch = writeBatch(db);
    batch.set(doc(db, 'extinguishers', id), {
      id, serial: $('#asn').value.trim(), manufacturer: $('#amf').value.trim(), type: $('#aty').value, capacity: $('#acp').value.trim(),
      branch: $('#abr').value.trim(), building: $('#abl').value.trim(), floor: $('#afl').value.trim(), area: $('#aar').value.trim(),
      mfgDate: $('#amd').value, lat: st.pos ? st.pos.lat : null, lng: st.pos ? st.pos.lng : null, radiusM: DEFAULT_RADIUS_M,
      createdBy: user.uid, createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'secrets', id), { token });
    batch.set(doc(db, 'publicStatus', id), { extId: id, updatedAt: serverTimestamp() });
    try {
      const r = await settle(batch.commit());
      const url = new URL('./', location.href).href + '?e=' + encodeURIComponent(id) + '&t=' + token;
      $('#lab').innerHTML = `<div class="card"><h2>${r === 'ok' ? 'تم التسجيل' : 'تم الحفظ على الجهاز'}</h2>
        <p class="muted">اطبع الملصق وركّبه على الطفاية. لا تشارك الرابط خارج فريق الفحص.</p>
        <div id="label"><b>${esc(id)}</b><div id="qr"></div><small>${esc($('#abr').value)} ${esc($('#abl').value)} ${esc($('#afl').value)}</small></div>
        <button class="btn" id="prt">طباعة الملصق</button><div style="height:8px"></div>
        <button class="btn alt" id="cpy">نسخ الرابط</button></div>`;
      if (window.QRCode) new window.QRCode($('#qr'), { text: url, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
      else $('#qr').textContent = 'تعذر تحميل مكتبة الكود الآن، انسخ الرابط واصنع الكود لاحقًا.';
      $('#prt').onclick = () => window.print();
      $('#cpy').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('تم نسخ الرابط.')).catch(() => toast(url)); };
      $('#lab').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      $('#aerr').innerHTML = `<div class="err">${esc(errMsg(e))}</div>`;
    }
    $('#asv').disabled = false;
  };
}
