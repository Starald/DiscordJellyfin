'use strict';

const $ = (id) => document.getElementById(id);

// ── Режим страницы ────────────────────────────────────────────────────────────
// index.html (обычная панель) содержит #channel; browser.html — нет. Один app.js
// обслуживает обе страницы: разница — только префикс API и часть привязок ниже.
const CHANNEL_MODE = !!$('channel');
const API_BASE = CHANNEL_MODE ? '/api' : '/api/browser';

/**
 * В режиме Discord — читает выбранный канал (или показывает тост и просит выбрать).
 * В режиме браузера канал не нужен вовсе — сразу «ок» без channelId.
 */
function requireChannel() {
  if (!CHANNEL_MODE) return { ok: true, channelId: undefined };
  const channelId = $('channel').value;
  if (!channelId) {
    toast('Сначала выбери голосовой канал');
    return { ok: false, channelId: undefined };
  }
  return { ok: true, channelId };
}

// ── API клиент ────────────────────────────────────────────────────────────────
const api = {
  async me() {
    const r = await fetch('/api/me');
    return r.ok ? r.json() : { authed: false };
  },
  async login(password) {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { ok: r.ok, status: r.status };
  },
  async logout() {
    await fetch('/api/logout', { method: 'POST' });
  },
  async adminLogin(password) {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { ok: r.ok, status: r.status };
  },
  async adminLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
  },
  async adminRestart() {
    const r = await fetch('/api/admin/restart', { method: 'POST' });
    return r.ok ? r.json() : { ok: false };
  },
  async state() {
    const r = await fetch(`${API_BASE}/state`);
    if (r.status === 401) throw new Error('unauth');
    return r.json();
  },
  async channels() {
    const r = await fetch('/api/channels');
    return r.ok ? r.json() : [];
  },
  async join(channelId) {
    const r = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    });
    return r.ok ? r.json() : { ok: false };
  },
  async search(q, type, offset = 0) {
    const r = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&type=${type}&offset=${offset}`,
    );
    return r.ok ? r.json() : { items: [], total: 0 };
  },
  async itemTracks(id, type) {
    const r = await fetch(`/api/tracks?id=${encodeURIComponent(id)}&type=${type}`);
    return r.ok ? (await r.json()).tracks : [];
  },
  async play(opts) {
    const r = await fetch(`${API_BASE}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return r.json();
  },
  async control(action) {
    const r = await fetch(`${API_BASE}/control/` + action, { method: 'POST' });
    return r.ok ? r.json() : {};
  },
  async seek(positionMs) {
    await fetch(`${API_BASE}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionMs }),
    });
  },
  async queueRemove(index) {
    await fetch(`${API_BASE}/queue/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
  },
  async queueMove(from, to) {
    await fetch(`${API_BASE}/queue/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
  },
  async random(channelId, position) {
    const r = await fetch(`${API_BASE}/random`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, position }),
    });
    return r.json();
  },
  async ytSearch(q) {
    const r = await fetch(`/api/yt/search?q=${encodeURIComponent(q)}`);
    return r.ok ? (await r.json()).items : [];
  },
  async ytPlay(opts) {
    const r = await fetch(`${API_BASE}/yt/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return r.json();
  },
  async ytResolve(url) {
    const r = await fetch(`/api/yt/resolve?url=${encodeURIComponent(url)}`);
    return r.ok ? (await r.json()).item : null;
  },
  async ytTracks(url) {
    const r = await fetch(`/api/yt/tracks?url=${encodeURIComponent(url)}`);
    return r.ok ? (await r.json()).tracks : [];
  },
  async yaSearch(q, type) {
    const r = await fetch(`/api/ya/search?q=${encodeURIComponent(q)}&type=${type}`);
    return r.ok ? (await r.json()).items : [];
  },
  async yaResolve(url) {
    const r = await fetch(`/api/ya/resolve?url=${encodeURIComponent(url)}`);
    return r.ok ? (await r.json()).item : null;
  },
  async yaTracks(id, type) {
    const r = await fetch(`/api/ya/tracks?id=${encodeURIComponent(id)}&type=${type}`);
    return r.ok ? (await r.json()).tracks : [];
  },
  async yaPlay(opts) {
    const r = await fetch(`${API_BASE}/ya/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return r.json();
  },
  async vkSearch(q, type) {
    const r = await fetch(`/api/vk/search?q=${encodeURIComponent(q)}&type=${type}`);
    return r.ok ? (await r.json()).items : [];
  },
  async vkResolve(url) {
    const r = await fetch(`/api/vk/resolve?url=${encodeURIComponent(url)}`);
    return r.ok ? (await r.json()).item : null;
  },
  async vkTracks(id, type) {
    const r = await fetch(`/api/vk/tracks?id=${encodeURIComponent(id)}&type=${type}`);
    return r.ok ? (await r.json()).tracks : [];
  },
  async vkPlay(opts) {
    const r = await fetch(`${API_BASE}/vk/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return r.json();
  },
  async history() {
    const r = await fetch('/api/history');
    return r.ok ? (await r.json()).items : [];
  },
  async historyPlay(channelId, id, position) {
    const r = await fetch(`${API_BASE}/history/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, id, position }),
    });
    return r.json();
  },
};

const artUrl = (id) => (id ? `/art/${id}?h=128` : null);

// Обложка не загрузилась → подменяем картинку на плашку «нет фото».
function imgFallback(img) {
  const d = document.createElement('div');
  d.className = (img.className || '').includes('np-art') ? 'np-art noimg' : 'noimg';
  d.textContent = 'нет фото';
  img.replaceWith(d);
}
window.imgFallback = imgFallback;

// ── Сохранение результатов поиска (переживает обновление страницы) ──────────────
const SEARCH_KEY = 'jellyfinds:search';
function loadSearchStore() {
  try {
    return JSON.parse(localStorage.getItem(SEARCH_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSearchStore(store) {
  try {
    localStorage.setItem(SEARCH_KEY, JSON.stringify(store));
  } catch {
    /* квота / приватный режим — просто не сохраняем */
  }
}
function persistTab(tab, data) {
  const store = loadSearchStore();
  store[tab] = data;
  saveSearchStore(store);
}
// Забыть сохранённые результаты вкладки (чтобы после перезагрузки они не вернулись).
function clearTab(tab) {
  const store = loadSearchStore();
  delete store[tab];
  saveSearchStore(store);
}

// Черновик строки поиска — последний НАБРАННЫЙ текст (даже если Enter/«Найти» не нажимали).
// Отдельный маленький ключ: пишем на каждый ввод, не сериализуя крупный store с результатами.
const DRAFT_KEY = 'jellyfinds:search-draft';
function loadDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {};
  } catch {
    return {};
  }
}
function saveDraft(tab, text) {
  try {
    const d = loadDrafts();
    d[tab] = text;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* квота / приватный режим — просто не сохраняем */
  }
}
function activateTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('tabJellyfin').classList.toggle('hidden', tab !== 'jellyfin');
  $('tabYoutube').classList.toggle('hidden', tab !== 'youtube');
  $('tabYandex').classList.toggle('hidden', tab !== 'yandex');
  $('tabVk').classList.toggle('hidden', tab !== 'vk');
  const store = loadSearchStore();
  store.active = tab;
  saveSearchStore(store);
}

// ── Утилиты ───────────────────────────────────────────────────────────────────
function fmt(ms) {
  if (!ms || ms < 0) ms = 0;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── Логин ───────────────────────────────────────────────────────────────────
let pollTimer, channelsTimer;

function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  clearInterval(pollTimer);
  clearInterval(channelsTimer);
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  startApp();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api.login($('loginPass').value);
  const err = $('loginError');
  if (res.ok) {
    err.classList.add('hidden');
    $('loginPass').value = '';
    showApp();
  } else {
    err.textContent =
      res.status === 429
        ? 'Слишком много попыток. Подожди немного и попробуй снова.'
        : 'Неверный пароль';
    err.classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async () => {
  await api.logout();
  showLogin();
});

$('jellyfinLink').addEventListener('click', () => window.open('https://starald.ru', '_blank'));
$('browserModeBtn')?.addEventListener('click', () => {
  window.location.href = 'browser.html';
});
$('backToPanelBtn')?.addEventListener('click', () => {
  window.location.href = 'index.html';
});

// ── Администрирование (пароль → сертификат / логи) ─────────────────────────────
async function openAdmin() {
  $('adminModal').classList.remove('hidden');
  let me = { admin: false };
  try {
    me = await api.me();
  } catch {
    /* ignore */
  }
  renderAdmin(!!me.admin);
}

function renderAdmin(isAdmin) {
  const b = $('adminBody');
  if (isAdmin) {
    b.innerHTML =
      `<button class="adminlink primary" id="adminCert">Сертификат сайта</button>` +
      `<button class="adminlink primary" id="adminLogs">Логи бота</button>` +
      `<button class="adminlink admin-restart" id="adminRestart">Перезагрузить бота</button>` +
      `<button class="adminlink admin-lock" id="adminLock">Выйти из админки</button>`;
    $('adminCert').addEventListener('click', () => window.open('cert.html', '_blank'));
    $('adminLogs').addEventListener('click', () => window.open('logs.html', '_blank'));
    $('adminRestart').addEventListener('click', async () => {
      if (
        !confirm(
          'Перезапустить бота? Текущее воспроизведение прервётся, панель переподключится через несколько секунд.',
        )
      )
        return;
      const res = await api.adminRestart();
      toast(res.message || 'Перезапускаю…');
      $('adminModal').classList.add('hidden');
    });
    $('adminLock').addEventListener('click', async () => {
      await api.adminLogout();
      renderAdmin(false);
    });
  } else {
    b.innerHTML =
      `<input id="adminPass" type="password" placeholder="Пароль администратора" autocomplete="off" />` +
      `<button class="adminlink primary" id="adminEnter">Войти</button>` +
      `<div id="adminErr" class="login-error hidden"></div>`;
    $('adminEnter').addEventListener('click', adminTryLogin);
    $('adminPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') adminTryLogin();
    });
    $('adminPass').focus();
  }
}

async function adminTryLogin() {
  const res = await api.adminLogin($('adminPass').value);
  if (res.ok) {
    renderAdmin(true);
  } else {
    const e = $('adminErr');
    e.textContent = res.status === 429 ? 'Слишком много попыток. Подожди.' : 'Неверный пароль';
    e.classList.remove('hidden');
  }
}

$('adminBtn').addEventListener('click', openAdmin);
$('adminClose').addEventListener('click', () => $('adminModal').classList.add('hidden'));
$('adminModal').addEventListener('click', (e) => {
  if (e.target.id === 'adminModal') $('adminModal').classList.add('hidden');
});

// ── История прослушиваний ─────────────────────────────────────────────────────
async function openHistory() {
  const ul = $('historyList');
  ul.innerHTML = '<li class="muted">загрузка…</li>';
  $('historyModal').classList.remove('hidden');
  let items = [];
  try {
    items = await api.history();
  } catch {
    /* ignore */
  }
  renderHistory(items);
}

function renderHistory(items) {
  const ul = $('historyList');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">История пуста — ещё ничего не играло.</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'result';
    const url = r.artId ? artUrl(r.artId) : r.thumb || null;
    const img = url ? `<img src="${url}" loading="lazy" onerror="imgFallback(this)" />` : `<div class="noimg">нет фото</div>`;
    const sub = escapeHtml(r.artist || '') + (r.durationMs ? ` · ${fmt(r.durationMs)}` : '');
    li.innerHTML =
      `<div class="result-main">` +
      img +
      `<div class="meta"><div class="name">${srcBadge(r.source)} ${escapeHtml(r.title)}</div>` +
      `<div class="sub">${sub}</div></div>` +
      `<button class="nextbtn" title="Играть следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn" title="В конец очереди"><span class="material-icons">play_arrow</span></button>` +
      `</div>`;
    li.querySelector('.playbtn').addEventListener('click', () => histPlay(r, 'end'));
    li.querySelector('.nextbtn').addEventListener('click', () => histPlay(r, 'next'));
    ul.appendChild(li);
  }
}

async function histPlay(item, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.historyPlay(g.channelId, item.id, position);
  toast(res.message || 'Готово');
  poll();
}

$('historyBtn').addEventListener('click', openHistory);
$('historyClose').addEventListener('click', () => $('historyModal').classList.add('hidden'));
$('historyModal').addEventListener('click', (e) => {
  if (e.target.id === 'historyModal') $('historyModal').classList.add('hidden');
});
$('randomBtn').addEventListener('click', async () => {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.random(g.channelId);
  toast(res.message || 'Готово');
  poll();
});

// ── Вкладки Jellyfin / YouTube ────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ── YouTube ───────────────────────────────────────────────────────────────────
let ytSearchSeq = 0; // поколение запроса: ответ старого поиска не должен перетирать новый
async function ytDoSearch() {
  const q = $('ytSearch').value.trim();
  if (!q) {
    ytSearchSeq++; // отменяем возможный незавершённый поиск, чтобы он не вернул результаты
    $('ytResults').innerHTML = '';
    clearTab('youtube');
    return;
  }
  const seq = ++ytSearchSeq;
  const ul = $('ytResults');
  // Ссылка YouTube: плейлист (≥2) → карточкой; видео / плейлист из 1 → сразу в очередь.
  const isUrl = /^https?:\/\//i.test(q) || /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(q);
  if (isUrl) {
    ul.innerHTML = '<li class="muted">загрузка…</li>';
    let resolved = null;
    try {
      resolved = await api.ytResolve(q);
    } catch {
      /* ignore */
    }
    if (seq !== ytSearchSeq) return; // пока резолвили, стартовал новый поиск — старый ответ игнорируем
    if (!resolved) {
      ul.innerHTML = '';
      toast('Не разобрал ссылку YouTube');
      return;
    }
    if (resolved.kind === 'video') {
      ul.innerHTML = '';
      await ytPlay(resolved.video, 'end');
      return;
    }
    // плейлист
    if (resolved.count <= 1) {
      ul.innerHTML = '';
      await ytPlayPlaylist(resolved.id, 'end');
      return;
    }
    const card = {
      type: 'playlist',
      id: resolved.id,
      title: resolved.title,
      count: resolved.count,
      thumbId: resolved.thumbId,
    };
    renderYtResults([card]);
    persistTab('youtube', { q, items: [card] });
    return;
  }
  ul.innerHTML = '<li class="muted">поиск…</li>';
  let items = [];
  try {
    items = await api.ytSearch(q);
  } catch {
    /* ignore */
  }
  if (seq !== ytSearchSeq) return; // устаревший ответ — не трогаем результаты/память
  renderYtResults(items);
  persistTab('youtube', { q, items });
}

function renderYtResults(items) {
  const ul = $('ytResults');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'result';

    if (r.type === 'playlist') {
      const img = r.thumbId
        ? `<img src="/yt/thumb/${r.thumbId}" loading="lazy" onerror="imgFallback(this)" />`
        : `<div class="noimg">нет фото</div>`;
      li.innerHTML =
        `<div class="result-main">` +
        img +
        `<div class="meta"><div class="name">${escapeHtml(r.title)}</div>` +
        `<div class="sub">плейлист · ${r.count} видео</div></div>` +
        `<button class="expandbtn" title="Показать видео"><span class="material-icons">expand_more</span></button>` +
        `<button class="nextbtn" title="Весь плейлист следующим"><span class="material-icons">queue_play_next</span></button>` +
        `<button class="playbtn" title="Играть весь плейлист"><span class="material-icons">play_arrow</span></button>` +
        `</div>` +
        `<ul class="subtracks hidden"></ul>`;
      li.querySelector('.playbtn').addEventListener('click', () => ytPlayPlaylist(r.id, 'end'));
      li.querySelector('.nextbtn').addEventListener('click', () => ytPlayPlaylist(r.id, 'next'));
      const exp = li.querySelector('.expandbtn');
      const container = li.querySelector('.subtracks');
      exp.addEventListener('click', () => ytToggle(r, exp, container));
      ul.appendChild(li);
      continue;
    }

    const dur = r.durationMs ? fmt(r.durationMs) : '';
    const sub = escapeHtml(r.channel || '') + (dur ? ` · ${dur}` : '');
    li.innerHTML =
      `<div class="result-main">` +
      `<img src="/yt/thumb/${r.id}" loading="lazy" onerror="imgFallback(this)" />` +
      `<div class="meta"><div class="name">${escapeHtml(r.title)}</div>` +
      `<div class="sub">${sub}</div></div>` +
      `<button class="nextbtn" title="Играть следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn" title="В конец очереди"><span class="material-icons">play_arrow</span></button>` +
      `</div>`;
    li.querySelector('.playbtn').addEventListener('click', () => ytPlay(r, 'end'));
    li.querySelector('.nextbtn').addEventListener('click', () => ytPlay(r, 'next'));
    ul.appendChild(li);
  }
}

async function ytToggle(item, btn, container) {
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_more';
    return;
  }
  container.classList.remove('hidden');
  if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_less';
  if (container.dataset.loaded !== '1') {
    container.innerHTML = '<li class="muted">загрузка…</li>';
    const videos = await api.ytTracks(item.id);
    container.dataset.loaded = '1';
    renderYtSubtracks(container, videos);
  }
}

function renderYtSubtracks(container, videos) {
  container.innerHTML = '';
  if (!videos.length) {
    container.innerHTML = '<li class="muted">нет видео</li>';
    return;
  }
  videos.forEach((v) => {
    const li = document.createElement('li');
    li.className = 'subtrack';
    const meta = escapeHtml(v.channel || '') + (v.durationMs ? ` · ${fmt(v.durationMs)}` : '');
    li.innerHTML =
      `<span class="st-meta">${escapeHtml(v.title)} ` +
      `<span class="qsub">— ${meta}</span></span>` +
      `<button class="nextbtn stbtn st-next" title="Следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn stbtn st-play" title="Играть / в конец"><span class="material-icons">play_arrow</span></button>`;
    li.querySelector('.st-play').addEventListener('click', () => ytPlay(v, 'end'));
    li.querySelector('.st-next').addEventListener('click', () => ytPlay(v, 'next'));
    container.appendChild(li);
  });
}

async function ytPlay(item, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.ytPlay({
    channelId: g.channelId,
    videoId: item.id,
    title: item.title,
    channel: item.channel,
    durationMs: item.durationMs,
    position,
  });
  toast(res.message || 'Готово');
  poll();
}

async function ytPlayPlaylist(url, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.ytPlay({ channelId: g.channelId, playlistUrl: url, position });
  toast(res.message || 'Готово');
  poll();
}

$('ytGo').addEventListener('click', ytDoSearch);
$('ytSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ytDoSearch();
});
$('ytSearch').addEventListener('input', () => saveDraft('youtube', $('ytSearch').value));

// ── Яндекс.Музыка ──────────────────────────────────────────────────────────────
let yaSearchSeq = 0; // поколение запроса (как в YouTube — защита от гонки ответов)
async function yaDoSearch() {
  const q = $('yaSearch').value.trim();
  if (!q) {
    yaSearchSeq++; // отменяем возможный незавершённый поиск, чтобы он не вернул результаты
    $('yaResults').innerHTML = '';
    clearTab('yandex');
    return;
  }
  const seq = ++yaSearchSeq;
  // Ссылка Яндекс.Музыки: альбом/плейлист (≥2) → карточкой; трек / 1 трек → сразу в очередь.
  if (/music\.yandex\./i.test(q)) {
    const ul = $('yaResults');
    ul.innerHTML = '<li class="muted">загрузка…</li>';
    let item = null;
    try {
      item = await api.yaResolve(q);
    } catch {
      /* ignore */
    }
    if (seq !== yaSearchSeq) return; // стартовал новый поиск — старый ответ игнорируем
    if (!item) {
      ul.innerHTML = '';
      toast('Не разобрал ссылку Яндекс.Музыки');
      return;
    }
    const single = item.type === 'track' || (typeof item.count === 'number' && item.count <= 1);
    if (single) {
      ul.innerHTML = '';
      await yaPlay(item, 'end');
      return;
    }
    renderYaResults([item]);
    persistTab('yandex', { q, type: $('yaType').value, items: [item] });
    return;
  }
  const ul = $('yaResults');
  ul.innerHTML = '<li class="muted">поиск…</li>';
  let items = [];
  try {
    items = await api.yaSearch(q, $('yaType').value);
  } catch {
    /* ignore */
  }
  if (seq !== yaSearchSeq) return; // устаревший ответ — не трогаем результаты/память
  renderYaResults(items);
  persistTab('yandex', { q, type: $('yaType').value, items });
}

function renderYaResults(items) {
  const ul = $('yaResults');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'result';
    const img = r.coverUrl ? `<img src="${r.coverUrl}" loading="lazy" onerror="imgFallback(this)" />` : `<div class="noimg">нет фото</div>`;
    const sub = escapeHtml(r.artist || '') + (r.year ? ` · ${r.year}` : '');
    const canExpand = r.type === 'album' || r.type === 'artist' || r.type === 'playlist';
    const expandBtn = canExpand ? `<button class="expandbtn" title="Показать треки"><span class="material-icons">expand_more</span></button>` : '';
    li.innerHTML =
      `<div class="result-main">` +
      img +
      `<div class="meta"><div class="name">${escapeHtml(r.name)}</div>` +
      `<div class="sub">${sub}</div></div>` +
      expandBtn +
      `<button class="nextbtn" title="Играть следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn" title="В конец очереди"><span class="material-icons">play_arrow</span></button>` +
      `</div>` +
      `<ul class="subtracks hidden"></ul>`;
    li.querySelector('.playbtn').addEventListener('click', () => yaPlay(r, 'end'));
    li.querySelector('.nextbtn').addEventListener('click', () => yaPlay(r, 'next'));
    const exp = li.querySelector('.expandbtn');
    if (exp) {
      const container = li.querySelector('.subtracks');
      exp.addEventListener('click', () => yaToggle(r, exp, container));
    }
    ul.appendChild(li);
  }
}

async function yaToggle(item, btn, container) {
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_more';
    return;
  }
  container.classList.remove('hidden');
  if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_less';
  if (container.dataset.loaded !== '1') {
    container.innerHTML = '<li class="muted">загрузка…</li>';
    const tracks = await api.yaTracks(item.id, item.type);
    container.dataset.loaded = '1';
    renderYaSubtracks(container, tracks);
  }
}

function renderYaSubtracks(container, tracks) {
  container.innerHTML = '';
  if (!tracks.length) {
    container.innerHTML = '<li class="muted">нет треков</li>';
    return;
  }
  tracks.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'subtrack';
    li.innerHTML =
      `<span class="st-meta">${escapeHtml(t.title)} ` +
      `<span class="qsub">— ${escapeHtml(t.artist)} · ${fmt(t.durationMs)}</span></span>` +
      `<button class="nextbtn stbtn st-next" title="Следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn stbtn st-play" title="Играть / в конец"><span class="material-icons">play_arrow</span></button>`;
    li.querySelector('.st-play').addEventListener('click', () => yaPlayTrack(t, 'end'));
    li.querySelector('.st-next').addEventListener('click', () => yaPlayTrack(t, 'next'));
    container.appendChild(li);
  });
}

async function yaPlay(item, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.yaPlay({
    channelId: g.channelId,
    id: item.id,
    type: item.type,
    title: item.name,
    artist: item.artist,
    durationMs: item.durationMs,
    coverUrl: item.coverUrl,
    position,
  });
  toast(res.message || 'Готово');
  poll();
}

async function yaPlayTrack(t, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.yaPlay({
    channelId: g.channelId,
    id: t.id,
    type: 'track',
    title: t.title,
    artist: t.artist,
    durationMs: t.durationMs,
    coverUrl: t.coverUrl,
    position,
  });
  toast(res.message || 'Готово');
  poll();
}

$('yaGo').addEventListener('click', yaDoSearch);
$('yaSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') yaDoSearch();
});
$('yaSearch').addEventListener('input', () => saveDraft('yandex', $('yaSearch').value));
$('yaType').addEventListener('change', () => {
  if ($('yaSearch').value.trim()) yaDoSearch();
});

// ── ВКонтакте ────────────────────────────────────────────────────────────────
let vkSearchSeq = 0; // поколение запроса (как в YouTube — защита от гонки ответов)
async function vkDoSearch() {
  const q = $('vkSearch').value.trim();
  if (!q) {
    vkSearchSeq++; // отменяем возможный незавершённый поиск, чтобы он не вернул результаты
    $('vkResults').innerHTML = '';
    clearTab('vk');
    return;
  }
  const seq = ++vkSearchSeq;
  const ul = $('vkResults');
  // Ссылка vk.com → показываем результатом (плейлист/трек), а не добавляем сразу.
  if (/vk\.(?:com|ru)/i.test(q)) {
    ul.innerHTML = '<li class="muted">загрузка…</li>';
    let item = null;
    try {
      item = await api.vkResolve(q);
    } catch {
      /* ignore */
    }
    if (seq !== vkSearchSeq) return; // стартовал новый поиск — старый ответ игнорируем
    if (!item) {
      ul.innerHTML = '';
      toast('Не разобрал ссылку ВКонтакте');
      return;
    }
    const single = item.type === 'track' || (typeof item.count === 'number' && item.count <= 1);
    if (single) {
      ul.innerHTML = '';
      await vkPlay(item, 'end');
      return;
    }
    renderVkResults([item]);
    persistTab('vk', { q, type: $('vkType').value, items: [item] });
    return;
  }
  ul.innerHTML = '<li class="muted">поиск…</li>';
  let items = [];
  try {
    items = await api.vkSearch(q, $('vkType').value);
  } catch {
    /* ignore */
  }
  if (seq !== vkSearchSeq) return; // устаревший ответ — не трогаем результаты/память
  renderVkResults(items);
  persistTab('vk', { q, type: $('vkType').value, items });
}

function renderVkResults(items) {
  const ul = $('vkResults');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'result';
    const img = r.coverUrl ? `<img src="${r.coverUrl}" loading="lazy" onerror="imgFallback(this)" />` : `<div class="noimg">нет фото</div>`;
    const sub = escapeHtml(r.artist || '');
    const canExpand = r.type === 'playlist';
    const expandBtn = canExpand ? `<button class="expandbtn" title="Показать треки"><span class="material-icons">expand_more</span></button>` : '';
    li.innerHTML =
      `<div class="result-main">` +
      img +
      `<div class="meta"><div class="name">${escapeHtml(r.name)}</div>` +
      `<div class="sub">${sub}</div></div>` +
      expandBtn +
      `<button class="nextbtn" title="Играть следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn" title="В конец очереди"><span class="material-icons">play_arrow</span></button>` +
      `</div>` +
      `<ul class="subtracks hidden"></ul>`;
    li.querySelector('.playbtn').addEventListener('click', () => vkPlay(r, 'end'));
    li.querySelector('.nextbtn').addEventListener('click', () => vkPlay(r, 'next'));
    const exp = li.querySelector('.expandbtn');
    if (exp) {
      const container = li.querySelector('.subtracks');
      exp.addEventListener('click', () => vkToggle(r, exp, container));
    }
    ul.appendChild(li);
  }
}

async function vkToggle(item, btn, container) {
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_more';
    return;
  }
  container.classList.remove('hidden');
  if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_less';
  if (container.dataset.loaded !== '1') {
    container.innerHTML = '<li class="muted">загрузка…</li>';
    const tracks = await api.vkTracks(item.id, item.type);
    container.dataset.loaded = '1';
    renderVkSubtracks(container, tracks);
  }
}

function renderVkSubtracks(container, tracks) {
  container.innerHTML = '';
  if (!tracks.length) {
    container.innerHTML = '<li class="muted">нет треков</li>';
    return;
  }
  tracks.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'subtrack';
    li.innerHTML =
      `<span class="st-meta">${escapeHtml(t.title)} ` +
      `<span class="qsub">— ${escapeHtml(t.artist)} · ${fmt(t.durationMs)}</span></span>` +
      `<button class="nextbtn stbtn st-next" title="Следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn stbtn st-play" title="Играть / в конец"><span class="material-icons">play_arrow</span></button>`;
    li.querySelector('.st-play').addEventListener('click', () => vkPlayTrack(t, 'end'));
    li.querySelector('.st-next').addEventListener('click', () => vkPlayTrack(t, 'next'));
    container.appendChild(li);
  });
}

async function vkPlay(item, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.vkPlay({
    channelId: g.channelId,
    id: item.id,
    type: item.type,
    title: item.name,
    artist: item.artist,
    durationMs: item.durationMs,
    coverUrl: item.coverUrl,
    position,
  });
  toast(res.message || 'Готово');
  poll();
}

async function vkPlayTrack(t, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.vkPlay({
    channelId: g.channelId,
    id: t.id,
    type: 'track',
    title: t.title,
    artist: t.artist,
    durationMs: t.durationMs,
    coverUrl: t.coverUrl,
    position,
  });
  toast(res.message || 'Готово');
  poll();
}

$('vkGo').addEventListener('click', vkDoSearch);
$('vkSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') vkDoSearch();
});
$('vkSearch').addEventListener('input', () => saveDraft('vk', $('vkSearch').value));
$('vkType').addEventListener('change', () => {
  if ($('vkSearch').value.trim()) vkDoSearch();
});

// ── Каналы ──────────────────────────────────────────────────────────────────
async function refreshChannels() {
  const sel = $('channel');
  if (!sel) return;
  const channels = await api.channels();
  const prev = sel.value;
  sel.innerHTML = '';
  if (!channels.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(каналов нет / бот не готов)';
    sel.appendChild(o);
    return;
  }
  for (const c of channels) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.members ? `${c.name} (${c.members})` : c.name;
    sel.appendChild(o);
  }
  if (channels.some((c) => c.id === prev)) sel.value = prev;
}

// ── Поиск ─────────────────────────────────────────────────────────────────────
let searchTimer;
let searchState = { q: '', type: 'album', offset: 0, total: 0, loading: false };
let jfItems = []; // накопленные результаты Jellyfin (для сохранения между обновлениями)

function onSearchInput() {
  saveDraft('jellyfin', $('search').value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(true), 300);
}

async function doSearch(reset) {
  if (reset) {
    searchState = {
      q: $('search').value.trim(),
      type: $('type').value,
      offset: 0,
      total: 0,
      loading: false,
    };
    jfItems = [];
    $('results').innerHTML = '';
  }
  if (searchState.loading) return;
  if (!reset && searchState.total > 0 && searchState.offset >= searchState.total) return;

  searchState.loading = true;
  try {
    const { items, total } = await api.search(searchState.q, searchState.type, searchState.offset);
    searchState.total = total;
    searchState.offset += items.length;
    jfItems.push(...items);
    appendResults(items, reset);
    persistTab('jellyfin', {
      q: searchState.q,
      type: searchState.type,
      items: jfItems,
      offset: searchState.offset,
      total: searchState.total,
    });
  } catch {
    toast('Ошибка поиска');
  } finally {
    searchState.loading = false;
  }
}

function appendResults(items, reset) {
  const ul = $('results');
  if (reset) ul.innerHTML = '';
  const empty = ul.querySelector('.muted');
  if (empty) empty.remove();
  if (reset && items.length === 0) {
    ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'result';
    const url = artUrl(r.artId);
    const img = url ? `<img src="${url}" loading="lazy" onerror="imgFallback(this)" />` : `<div class="noimg">нет фото</div>`;
    const sub = escapeHtml(r.artist || '') + (r.year ? ` · ${r.year}` : '');
    const canExpand = r.type === 'album' || r.type === 'artist' || r.type === 'playlist';
    const expandBtn = canExpand
      ? `<button class="expandbtn" title="Показать треки"><span class="material-icons">expand_more</span></button>`
      : '';
    li.innerHTML =
      `<div class="result-main">` +
      `${img}<div class="meta"><div class="name">${escapeHtml(r.name)}</div>` +
      `<div class="sub">${sub}</div></div>` +
      expandBtn +
      `<button class="nextbtn" title="Играть следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn" title="В конец очереди"><span class="material-icons">play_arrow</span></button>` +
      `</div>` +
      `<ul class="subtracks hidden"></ul>`;
    li.querySelector('.playbtn').addEventListener('click', () => play(r, 'end'));
    li.querySelector('.nextbtn').addEventListener('click', () => play(r, 'next'));
    const exp = li.querySelector('.expandbtn');
    if (exp) {
      const container = li.querySelector('.subtracks');
      exp.addEventListener('click', () => toggleAlbum(r, exp, container));
    }
    ul.appendChild(li);
  }
}

async function toggleAlbum(item, btn, container) {
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_more';
    return;
  }
  container.classList.remove('hidden');
  if (btn.firstElementChild) btn.firstElementChild.textContent = 'expand_less';
  if (container.dataset.loaded !== '1') {
    container.innerHTML = '<li class="muted">загрузка…</li>';
    const tracks = await api.itemTracks(item.id, item.type);
    container.dataset.loaded = '1';
    renderSubtracks(container, tracks);
  }
}

function renderSubtracks(container, tracks) {
  container.innerHTML = '';
  if (!tracks.length) {
    container.innerHTML = '<li class="muted">нет треков</li>';
    return;
  }
  tracks.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'subtrack';
    const num = t.index != null ? `${t.index}.` : '';
    li.innerHTML =
      `<span class="st-num">${num}</span>` +
      `<span class="st-meta">${escapeHtml(t.title)} ` +
      `<span class="qsub">— ${escapeHtml(t.artist)} · ${fmt(t.durationMs)}</span></span>` +
      `<button class="nextbtn stbtn st-next" title="Следующим"><span class="material-icons">queue_play_next</span></button>` +
      `<button class="playbtn stbtn st-play" title="Играть / в конец"><span class="material-icons">play_arrow</span></button>`;
    li.querySelector('.st-play').addEventListener('click', () => playTrack(t.id, 'end'));
    li.querySelector('.st-next').addEventListener('click', () => playTrack(t.id, 'next'));
    container.appendChild(li);
  });
}

async function playTrack(trackId, position) {
  const g = requireChannel();
  if (!g.ok) return;
  const res = await api.play({ channelId: g.channelId, query: trackId, type: 'track', position });
  toast(res.message || 'Готово');
  poll();
}

// Бесконечная подгрузка при прокрутке к низу списка.
$('results').addEventListener('scroll', () => {
  const ul = $('results');
  if (ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 80) doSearch(false);
});
async function play(item, position = 'end') {
  const g = requireChannel();
  if (!g.ok) return;
  try {
    const res = await api.play({ channelId: g.channelId, query: item.id, type: item.type, position });
    toast(res.message || 'Готово');
    poll();
  } catch {
    toast('Не удалось запустить воспроизведение');
  }
}

// ── Состояние ───────────────────────────────────────────────────────────────
let npDuration = 0; // длительность текущего трека (для перемотки кликом)
let lastQueueKey = ''; // чтобы перерисовывать очередь только при изменении
let lastNpKey = ''; // чтобы не пересоздавать <img> «сейчас играет» каждую секунду
let channelDefaulted = false; // применили ли запомненный канал в выпадашке

function renderState(s) {
  if (!s) return;
  $('status').textContent = CHANNEL_MODE
    ? s.connected
      ? 'в голосовом канале'
      : s.ready
        ? 'готов'
        : 'подключение…'
    : s.nowPlaying
      ? s.paused
        ? 'на паузе'
        : 'воспроизведение'
      : 'готово';

  // Иконка play/pause (общая кнопка — управляет паузой для всех окон).
  const pauseIcon = $('pause').querySelector('.material-icons');
  if (pauseIcon) pauseIcon.textContent = s.nowPlaying && !s.paused ? 'pause' : 'play_arrow';

  // Предвыбор запомненного канала — один раз, пока пользователь сам не выбрал.
  if (!channelDefaulted && s.lastChannelId) {
    const sel = $('channel');
    if ([...sel.options].some((o) => o.value === s.lastChannelId)) {
      sel.value = s.lastChannelId;
      channelDefaulted = true;
    }
  }

  const np = s.nowPlaying;
  npDuration = np ? np.durationMs : 0;
  const el = $('nowplaying');
  const ratio = np && np.durationMs ? Math.min(100, (np.playbackMs / np.durationMs) * 100) : 0;
  // Полный ребилд (с <img>) — только при СМЕНЕ ТРЕКА. Иначе каждый poll пересоздавал
  // бы <img> и долбил /art (а ещё буферизация плеера осциллирует play↔buffering).
  const npKey = np ? [np.title, np.artist, np.durationMs, np.artId, np.thumb, np.source].join('|') : 'none';

  if (npKey !== lastNpKey) {
    lastNpKey = npKey;
    if (!np) {
      el.innerHTML = '<div class="np-empty">Ничего не играет</div>';
    } else {
      const url = np.artId ? artUrl(np.artId) : np.thumb || null;
      const art = url
        ? `<img class="np-art" src="${url}" onerror="imgFallback(this)" />`
        : `<div class="np-art noimg">нет фото</div>`;
      el.innerHTML =
        art +
        `<div class="np-info">` +
        `<div class="np-title">${srcBadge(np.source)} ${escapeHtml(np.title)}</div>` +
        `<div class="np-artist">${escapeHtml(np.artist)}</div>` +
        `<div class="bar"><div class="fill" style="width:${ratio}%"></div></div>` +
        `<div class="times"><span>${fmt(np.playbackMs)}</span><span>${fmt(np.durationMs)}</span></div>` +
        `<div class="np-note"></div>` +
        `</div>`;
    }
  }

  if (np) {
    // Динамические части — каждый poll, БЕЗ пересоздания <img>.
    const fill = el.querySelector('.fill');
    if (fill) fill.style.width = ratio + '%';
    const cur = el.querySelector('.times span');
    if (cur) cur.textContent = fmt(np.playbackMs);
    const bar = el.querySelector('.bar');
    if (bar) bar.classList.toggle('loading', !!np.buffering);
    const note = el.querySelector('.np-note');
    if (note) {
      if (s.paused) {
        note.textContent = '⏸ на паузе';
        note.className = 'np-note paused';
      } else if (np.buffering) {
        note.textContent = 'загрузка…';
        note.className = 'np-note loading-note';
      } else {
        note.textContent = '';
        note.className = 'np-note';
      }
    }
  }

  // Очередь перерисовываем только при изменении (чтобы не мешать кликам по кнопкам).
  const qkey =
    s.queue.length + '|' + s.queue.map((t) => t.title + ':' + (t.prefetch || '')).join('|');
  if (qkey !== lastQueueKey) {
    lastQueueKey = qkey;
    renderQueue(s.queue);
  }

  if (!CHANNEL_MODE) updateBrowserAudio(s);
}

let dragFrom = null;

function srcBadge(source) {
  const label = { jellyfin: 'JF', youtube: 'YT', yandex: 'ЯМ', vk: 'VK' };
  return source && label[source] ? `<span class="src src-${source}">${label[source]}</span>` : '';
}

function renderQueue(items) {
  const q = $('queue');
  q.innerHTML = '';
  dragFrom = null;
  if (!items.length) {
    q.innerHTML = '<li class="muted">пусто</li>';
    return;
  }
  items.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'qitem';
    li.draggable = true;
    // Статус предзагрузки — показываем только у ПЕРВОГО трека (его готовим заранее).
    const prep =
      i !== 0
        ? ''
        : t.prefetch === 'loading'
          ? `<span class="qprep loading">идёт подготовка…</span>`
          : t.prefetch === 'ready'
            ? `<span class="qprep ready">готов</span>`
            : t.prefetch === 'error'
              ? `<span class="qprep err">ошибка подготовки</span>`
              : '';
    li.innerHTML =
      `<span class="qdrag" title="Перетащить">⠿</span>` +
      `<span class="qn">${i + 1}.</span>` +
      srcBadge(t.source) +
      `<span class="qmeta"><span class="qtitle">${escapeHtml(t.title)}</span>` +
      `<span class="qsub">${escapeHtml(t.artist)} · ${fmt(t.durationMs)}</span>` +
      prep +
      `</span>` +
      `<button class="qb del" title="Убрать из очереди">✕</button>`;

    li.querySelector('.del').addEventListener('click', async () => {
      await api.queueRemove(i);
      poll();
    });

    // Drag-and-drop перестановка.
    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      dragFrom = null;
      li.classList.remove('dragging');
      q.querySelectorAll('.dragover').forEach((el) => el.classList.remove('dragover'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragFrom !== null && dragFrom !== i) li.classList.add('dragover');
    });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('dragover');
      if (dragFrom !== null && dragFrom !== i) {
        const from = dragFrom;
        dragFrom = null;
        await api.queueMove(from, i);
        poll();
      }
    });

    q.appendChild(li);
  });
}
async function poll() {
  try {
    renderState(await api.state());
  } catch (e) {
    // 401 → сессия истекла, на логин. Сетевая ошибка (бот перезапускается) — молча ждём.
    if (e && e.message === 'unauth') showLogin();
  }
}

// ── Кнопки управления ─────────────────────────────────────────────────────────
$('pause').addEventListener('click', async () => {
  await api.control('pause');
  poll();
});
$('skip').addEventListener('click', async () => {
  await api.control('skip');
  poll();
});
$('shuffle').addEventListener('click', async () => {
  const r = await api.control('shuffle');
  toast(`Перемешано: ${r.count ?? 0}`);
  poll();
});
$('stop').addEventListener('click', async () => {
  await api.control('stop');
  poll();
});
$('leave')?.addEventListener('click', async () => {
  await api.control('leave');
  poll();
});
$('refreshChannels')?.addEventListener('click', refreshChannels);
// Пользователь сам выбрал канал → больше не перебиваем запомненным + сразу заходим туда.
$('channel')?.addEventListener('change', async () => {
  channelDefaulted = true;
  const channelId = $('channel').value;
  if (!channelId) return;
  const res = await api.join(channelId);
  toast(res.message || 'Подключаюсь…');
  poll();
});

// ── Режим «в браузере»: реальное аудио в <audio>, управляемое per-window чекбоксом ──
// «Слушать в этом окне» НЕ трогает сервер вообще — это чисто локальный выбор: слушать ли
// именно в этой вкладке. Пауза/скип/шафл/стоп остаются общими (кнопки выше, как в Discord-
// режиме) — они управляют одной на всех очередью. Клик по чекбоксу — тот самый пользова-
// тельский жест, без которого браузер не даст стартовать .play().
let lastBrowserPlayId = null;
$('listenToggle')?.addEventListener('change', () => {
  const audio = $('browserAudio');
  const toggle = $('listenToggle');
  if (!audio || !toggle) return;
  if (toggle.checked) {
    if (lastBrowserPlayId) {
      audio.src = `/api/browser/stream?play=${encodeURIComponent(lastBrowserPlayId)}`;
      audio.play().catch(() => {});
    }
    } else {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();     
  }
  });

function updateBrowserAudio(s) {
  const audio = $('browserAudio');
  if (!audio) return;
  const playId = s.nowPlaying ? s.nowPlaying.playId : null;
  if (playId === lastBrowserPlayId) return; // трек/прогон не менялся — нечего делать
  lastBrowserPlayId = playId;
  const toggle = $('listenToggle');
  if (!toggle || !toggle.checked) return; // это окно не слушает — просто запомнили playId на будущее
  if (playId) {  
    audio.src = `/api/browser/stream?play=${encodeURIComponent(playId)}`;
    audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
  }
}

$('search').addEventListener('input', onSearchInput);
$('type').addEventListener('change', () => doSearch(true));

// Перемотка: клик по прогресс-бару в «Сейчас играет».
$('nowplaying').addEventListener('click', (e) => {
  const bar = e.target.closest('.bar');
  if (!bar || !npDuration) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  api.seek(Math.floor(ratio * npDuration));
  setTimeout(poll, 300);
});

// ── Восстановление сохранённого поиска при загрузке страницы ────────────────────
function restoreSearch() {
  const store = loadSearchStore();

  // Jellyfin: либо восстанавливаем сохранённые результаты, либо дефолтный поиск.
  const j = store.jellyfin;
  if (j && Array.isArray(j.items) && j.items.length) {
    $('search').value = j.q || '';
    $('type').value = j.type || 'album';
    jfItems = j.items.slice();
    searchState = {
      q: j.q || '',
      type: j.type || 'album',
      offset: j.offset || j.items.length,
      total: j.total || 0,
      loading: false,
    };
    appendResults(j.items, true);
  } else {
    doSearch(true);
  }

  if (store.youtube && Array.isArray(store.youtube.items)) {
    $('ytSearch').value = store.youtube.q || '';
    renderYtResults(store.youtube.items);
  }
  if (store.yandex && Array.isArray(store.yandex.items)) {
    $('yaSearch').value = store.yandex.q || '';
    if (store.yandex.type) $('yaType').value = store.yandex.type;
    renderYaResults(store.yandex.items);
  }
  if (store.vk && Array.isArray(store.vk.items)) {
    $('vkSearch').value = store.vk.q || '';
    if (store.vk.type) $('vkType').value = store.vk.type;
    renderVkResults(store.vk.items);
  }

  // Поле поиска показывает ПОСЛЕДНИЙ НАБРАННЫЙ текст (черновик) — даже если поиск не запускали.
  // Делаем это ПОСЛЕ восстановления результатов: результаты — от последнего реального поиска,
  // а текст в поле — последний введённый (могут не совпадать — это и есть нужное поведение).
  const drafts = loadDrafts();
  if (typeof drafts.jellyfin === 'string') $('search').value = drafts.jellyfin;
  if (typeof drafts.youtube === 'string') $('ytSearch').value = drafts.youtube;
  if (typeof drafts.yandex === 'string') $('yaSearch').value = drafts.yandex;
  if (typeof drafts.vk === 'string') $('vkSearch').value = drafts.vk;

  if (store.active) activateTab(store.active);
}

// ── Запуск ──────────────────────────────────────────────────────────────────
function startApp() {
  refreshChannels();
  restoreSearch();
  poll();
  pollTimer = setInterval(poll, 1000);
  channelsTimer = setInterval(refreshChannels, 5000);
}

(async () => {
  const { authed } = await api.me();
  if (authed) showApp();
  else showLogin();
})();
