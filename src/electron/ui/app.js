'use strict';

const $ = (id) => document.getElementById(id);

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

// ── Каналы ───────────────────────────────────────────────────────────────────
async function refreshChannels() {
  const channels = await window.api.listChannels();
  const sel = $('channel');
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

// ── Поиск ────────────────────────────────────────────────────────────────────
let searchTimer;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 300);
}

async function doSearch() {
  const term = $('search').value.trim();
  const type = $('type').value;
  let results = [];
  try {
    results = await window.api.search(term, type);
  } catch (e) {
    toast('Ошибка поиска');
  }
  renderResults(results);
}

function renderResults(results) {
  const ul = $('results');
  ul.innerHTML = '';
  if (!results.length) {
    ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'result';
    const img = r.imageUrl
      ? `<img src="${r.imageUrl}" loading="lazy" />`
      : `<div class="noimg">♪</div>`;
    const sub = escapeHtml(r.artist || '') + (r.year ? ` · ${r.year}` : '');
    li.innerHTML =
      `${img}<div class="meta"><div class="name">${escapeHtml(r.name)}</div>` +
      `<div class="sub">${sub}</div></div><button class="playbtn">▶</button>`;
    li.querySelector('.playbtn').addEventListener('click', () => play(r));
    ul.appendChild(li);
  }
}

async function play(item) {
  const channelId = $('channel').value;
  if (!channelId) {
    toast('Сначала выбери голосовой канал');
    return;
  }
  try {
    const res = await window.api.play({ channelId, query: item.id, type: item.type });
    toast(res.message);
    poll();
  } catch (e) {
    toast('Не удалось запустить воспроизведение');
  }
}

// ── Состояние (now playing + очередь) ─────────────────────────────────────────
function renderState(s) {
  if (!s) {
    $('status').textContent = 'бот не запущен';
    return;
  }
  $('status').textContent = s.connected ? 'в голосовом канале' : s.ready ? 'готов' : 'подключение…';

  const np = s.nowPlaying;
  const el = $('nowplaying');
  if (!np) {
    el.innerHTML = '<div class="np-empty">Ничего не играет</div>';
  } else {
    const ratio = np.durationMs ? Math.min(100, (np.playbackMs / np.durationMs) * 100) : 0;
    const art = np.imageUrl
      ? `<img class="np-art" src="${np.imageUrl}" />`
      : `<div class="np-art noimg">♪</div>`;
    el.innerHTML =
      art +
      `<div class="np-info">` +
      `<div class="np-title">${escapeHtml(np.title)}</div>` +
      `<div class="np-artist">${escapeHtml(np.artist)}</div>` +
      `<div class="bar"><div class="fill" style="width:${ratio}%"></div></div>` +
      `<div class="times"><span>${fmt(np.playbackMs)}</span><span>${fmt(np.durationMs)}</span></div>` +
      (s.paused ? `<div class="paused">⏸ на паузе</div>` : '') +
      `</div>`;
  }

  const q = $('queue');
  q.innerHTML = '';
  if (!s.queue.length) {
    q.innerHTML = '<li class="muted">пусто</li>';
  } else {
    s.queue.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="qn">${i + 1}.</span> ${escapeHtml(t.title)} ` +
        `<span class="qsub">— ${escapeHtml(t.artist)} · ${fmt(t.durationMs)}</span>`;
      q.appendChild(li);
    });
  }
}

async function poll() {
  try {
    renderState(await window.api.getState());
  } catch (e) {
    /* ignore */
  }
}

// ── Кнопки управления ─────────────────────────────────────────────────────────
$('pause').addEventListener('click', async () => {
  await window.api.togglePause();
  poll();
});
$('skip').addEventListener('click', async () => {
  await window.api.skip();
  poll();
});
$('shuffle').addEventListener('click', async () => {
  const n = await window.api.shuffle();
  toast(`Перемешано: ${n}`);
  poll();
});
$('stop').addEventListener('click', async () => {
  await window.api.stop();
  poll();
});
$('leave').addEventListener('click', async () => {
  await window.api.leave();
  poll();
});
$('refreshChannels').addEventListener('click', refreshChannels);
$('search').addEventListener('input', onSearchInput);
$('type').addEventListener('change', doSearch);

if (window.api.onError) {
  window.api.onError((msg) => {
    const e = $('error');
    e.textContent = 'Ошибка запуска бота: ' + msg;
    e.classList.remove('hidden');
  });
}

// ── Старт ─────────────────────────────────────────────────────────────────────
refreshChannels();
doSearch();
poll();
setInterval(poll, 1000);
setInterval(refreshChannels, 5000);
