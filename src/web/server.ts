import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSession from 'cookie-session';
import express from 'express';
import type { SearchType } from '../audio/resolve.js';
import type { AppConfig } from '../config.js';
import type { Bot } from '../core/bot.js';
import { applyP12, applyPem, getCertInfo, revertToLE } from './cert.js';
import { getRecentLogs, logger } from '../logger.js';
import type { YmType } from '../yandex/client.js';
import type { VkType } from '../vk/client.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(dirname, 'ui');

const VALID_TYPES: SearchType[] = ['album', 'artist', 'playlist', 'track'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

/** Сравнение строк за постоянное время (через sha256, чтобы не утекала длина). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function startWebPanel(bot: Bot, config: AppConfig): void {
  const panel = config.panel;
  if (!panel.enabled) {
    logger.info('Веб-панель отключена (PANEL_ENABLED=false).');
    return;
  }
  if (!panel.password) {
    logger.warn(
      'PANEL_PASSWORD не задан — публичную веб-панель НЕ поднимаю (иначе кто угодно рулил бы ботом). ' +
        'Бот продолжает работать без панели.',
    );
    return;
  }

  const sessionSecret = panel.sessionSecret ?? crypto.randomBytes(32).toString('hex');
  if (!panel.sessionSecret) {
    logger.warn('SESSION_SECRET не задан — сгенерирован временный; сессии сбросятся при перезапуске.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // за nginx (X-Forwarded-*)
  app.use(express.json({ limit: '512kb' })); // 512kb — чтобы влезала загрузка сертификата
  app.use(
    cookieSession({
      name: 'dsbot.sid',
      keys: [sessionSecret],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: panel.secureCookie,
    }),
  );

  // ── Rate limit на логин ─────────────────────────────────────────────────────
  const attempts = new Map<string, { count: number; first: number }>();
  const isRateLimited = (ip: string): boolean => {
    const now = Date.now();
    const e = attempts.get(ip);
    if (!e || now - e.first > LOGIN_WINDOW_MS) {
      attempts.set(ip, { count: 0, first: now });
      return false;
    }
    return e.count >= LOGIN_MAX_ATTEMPTS;
  };
  const recordFail = (ip: string): void => {
    const e = attempts.get(ip);
    if (e) e.count += 1;
  };
  // Чистим устаревшие записи, иначе Map растёт без предела (много уникальных IP).
  const rlCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of attempts) {
      if (now - e.first > 2 * LOGIN_WINDOW_MS) attempts.delete(ip);
    }
  }, LOGIN_WINDOW_MS);
  if (typeof rlCleanup.unref === 'function') rlCleanup.unref();

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (req.session?.authed) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };

  // Раздел «Администрирование» (сертификат/логи) — нужен отдельный вход по паролю.
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (req.session?.authed && req.session?.admin) {
      next();
      return;
    }
    res.status(403).json({ error: 'admin_required' });
  };

  // ── Аутентификация ──────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (isRateLimited(ip)) {
      res.status(429).json({ ok: false, error: 'too_many_attempts' });
      return;
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const passOk = safeEqual(String(body.password ?? ''), panel.password!);
    // Логин по умолчанию — только пароль. Если username прислан, он тоже должен совпасть.
    const userOk =
      body.username === undefined || body.username === null || body.username === ''
        ? true
        : safeEqual(String(body.username), panel.username);
    if (passOk && userOk) {
      req.session!.authed = true;
      attempts.delete(ip); // сброс счётчика попыток при успешном входе
      res.json({ ok: true });
    } else {
      recordFail(ip);
      res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ authed: !!req.session?.authed, admin: !!req.session?.admin });
  });

  // Вход в раздел администрирования (отдельный пароль; по умолчанию = пароль панели).
  app.post('/api/admin/login', requireAuth, (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (isRateLimited(ip)) {
      res.status(429).json({ ok: false, error: 'too_many_attempts' });
      return;
    }
    const adminPass = panel.adminPassword ?? panel.password!;
    const body = (req.body ?? {}) as { password?: unknown };
    if (safeEqual(String(body.password ?? ''), adminPass)) {
      req.session!.admin = true;
      attempts.delete(ip);
      res.json({ ok: true });
    } else {
      recordFail(ip);
      res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
  });

  app.post('/api/admin/logout', requireAuth, (req, res) => {
    if (req.session) req.session.admin = false;
    res.json({ ok: true });
  });

  // Перезагрузка бота: отдельный detached-node ждёт ~2.5с (пока этот процесс умрёт и
  // освободит порт), затем поднимает новый инстанс. node -e (без cmd/powershell) —
  // чтобы не страдать от кавычек; выходим ТОЛЬКО после успешного спавна.
  app.post('/api/admin/restart', requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true, message: 'Перезапускаю бота…' });
    logger.info('Перезапуск бота по запросу из админ-панели.');
    const node = process.execPath;
    const script = process.argv[1] ?? 'dist/index.js';
    const cwd = process.cwd();
    const outLog = JSON.stringify(path.join(cwd, 'bot.out.log'));
    const errLog = JSON.stringify(path.join(cwd, 'bot.err.log'));
    const relaunchCode =
      `const{spawn}=require('child_process'),fs=require('fs');` +
      `setTimeout(()=>{` +
      `const o=fs.openSync(${outLog},'a'),e=fs.openSync(${errLog},'a');` +
      `spawn(${JSON.stringify(node)},[${JSON.stringify(script)}],` +
      `{cwd:${JSON.stringify(cwd)},detached:true,stdio:['ignore',o,e],windowsHide:true}).unref();` +
      `},2500);`;
    try {
      const child = spawn(node, ['-e', relaunchCode], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (e) => logger.error('Перезапуск: не удалось спавнить:', e));
      child.once('spawn', () => setTimeout(() => process.exit(0), 300));
      child.unref();
    } catch (err) {
      logger.error('Не удалось запланировать перезапуск:', err);
    }
  });

  // ── API бота (под авторизацией) ───────────────────────────────────────────
  app.get('/api/state', requireAuth, (_req, res) => {
    res.json(bot.getState());
  });

  app.get('/api/logs', requireAuth, requireAdmin, (_req, res) => {
    res.json({ lines: getRecentLogs(800) });
  });

  // ── Управление TLS-сертификатом сайта (только админ) ─────────────────────────
  app.get('/api/cert/status', requireAuth, requireAdmin, (_req, res) => {
    res.json(getCertInfo());
  });

  app.post('/api/cert/p12', requireAuth, requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as { fileBase64?: unknown; password?: unknown };
    if (typeof body.fileBase64 !== 'string' || !body.fileBase64) {
      res.status(400).json({ ok: false, message: 'Не приложен файл .p12.' });
      return;
    }
    try {
      const info = await applyP12(Buffer.from(body.fileBase64, 'base64'), String(body.password ?? ''));
      res.json({ ok: true, info });
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
    }
  });

  app.post('/api/cert/pem', requireAuth, requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as { certPem?: unknown; keyPem?: unknown };
    if (typeof body.certPem !== 'string' || typeof body.keyPem !== 'string') {
      res.status(400).json({ ok: false, message: 'Нужны и сертификат, и ключ (PEM).' });
      return;
    }
    try {
      const info = await applyPem(body.certPem, body.keyPem);
      res.json({ ok: true, info });
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
    }
  });

  app.post('/api/cert/revert', requireAuth, requireAdmin, async (_req, res) => {
    try {
      res.json({ ok: true, info: await revertToLE() });
    } catch (err) {
      res.status(500).json({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
    }
  });

  app.get('/api/channels', requireAuth, (_req, res) => {
    res.json(bot.listVoiceChannels());
  });

  app.post('/api/join', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { channelId?: unknown };
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      res.status(400).json({ ok: false, message: 'Не указан канал.' });
      return;
    }
    res.json(await bot.joinChannel(channelId));
  });

  app.get('/api/search', requireAuth, async (req, res) => {
    const q = String(req.query.q ?? '');
    const type = VALID_TYPES.includes(req.query.type as SearchType)
      ? (req.query.type as SearchType)
      : 'album';
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);
    try {
      res.json(await bot.searchPage(q, type, offset, 50));
    } catch {
      res.status(502).json({ error: 'search_failed' });
    }
  });

  app.post('/api/seek', requireAuth, (req, res) => {
    const body = (req.body ?? {}) as { positionMs?: unknown };
    const positionMs = Number(body.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.seek(positionMs) });
  });

  app.get('/api/tracks', requireAuth, async (req, res) => {
    const id = String(req.query.id ?? '');
    const type = VALID_TYPES.includes(req.query.type as SearchType)
      ? (req.query.type as SearchType)
      : 'album';
    if (!id) {
      res.status(400).json({ tracks: [] });
      return;
    }
    try {
      res.json({ tracks: await bot.getTracksFor(id, type) });
    } catch {
      res.status(502).json({ tracks: [] });
    }
  });

  app.post('/api/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      channelId?: unknown;
      query?: unknown;
      type?: unknown;
      position?: unknown;
    };
    const type = VALID_TYPES.includes(body.type as SearchType)
      ? (body.type as SearchType)
      : 'album';
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.channelId || !body.query) {
      res.status(400).json({ ok: false, message: 'Нужны channelId и query.' });
      return;
    }
    try {
      res.json(
        await bot.play({
          channelId: String(body.channelId),
          query: String(body.query),
          type,
          position,
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка воспроизведения.' });
    }
  });

  app.post('/api/random', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { channelId?: unknown; position?: unknown };
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.channelId) {
      res.status(400).json({ ok: false, message: 'Нужен channelId.' });
      return;
    }
    try {
      res.json(await bot.playRandom({ channelId: String(body.channelId), position }));
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  // ── История прослушиваний ────────────────────────────────────────────────────
  app.get('/api/history', requireAuth, (_req, res) => {
    res.json({ items: bot.getHistoryList() });
  });

  app.post('/api/history/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { channelId?: unknown; id?: unknown; position?: unknown };
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.channelId || !body.id) {
      res.status(400).json({ ok: false, message: 'Нужны channelId и id.' });
      return;
    }
    try {
      res.json(await bot.playFromHistory(String(body.channelId), String(body.id), position));
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  // ── YouTube ───────────────────────────────────────────────────────────────
  app.get('/api/yt/search', requireAuth, async (req, res) => {
    const q = String(req.query.q ?? '');
    if (!q.trim()) {
      res.json({ items: [] });
      return;
    }
    try {
      res.json({ items: await bot.ytSearch(q) });
    } catch {
      res.status(502).json({ items: [] });
    }
  });

  app.get('/api/yt/resolve', requireAuth, async (req, res) => {
    try {
      res.json({ item: await bot.ytResolveLink(String(req.query.url ?? '')) });
    } catch {
      res.json({ item: null });
    }
  });

  app.get('/api/yt/tracks', requireAuth, async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!url) {
      res.status(400).json({ tracks: [] });
      return;
    }
    try {
      res.json({ tracks: await bot.ytPlaylistVideos(url) });
    } catch {
      res.status(502).json({ tracks: [] });
    }
  });

  app.post('/api/yt/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      channelId?: unknown;
      videoId?: unknown;
      playlistUrl?: unknown;
      title?: unknown;
      channel?: unknown;
      durationMs?: unknown;
      position?: unknown;
    };
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.channelId) {
      res.status(400).json({ ok: false, message: 'Нужен channelId.' });
      return;
    }
    try {
      // Целый плейлист — добавляем все видео.
      if (typeof body.playlistUrl === 'string' && body.playlistUrl) {
        res.json(
          await bot.playYouTubePlaylist({
            channelId: String(body.channelId),
            url: body.playlistUrl,
            position,
          }),
        );
        return;
      }
      if (!body.videoId) {
        res.status(400).json({ ok: false, message: 'Нужны videoId или playlistUrl.' });
        return;
      }
      res.json(
        await bot.playYouTube({
          channelId: String(body.channelId),
          videoId: String(body.videoId),
          title: typeof body.title === 'string' ? body.title : undefined,
          channel: typeof body.channel === 'string' ? body.channel : undefined,
          durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
          position,
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  // Прокси обложек YouTube (сервер достаёт ytimg, у браузера может не быть доступа).
  app.get('/yt/thumb/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) {
      res.status(400).end();
      return;
    }
    try {
      let upstream = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok)
        upstream = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, {
          signal: AbortSignal.timeout(8000),
        });
      if (!upstream.ok) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).end();
    }
  });

  // ── Яндекс.Музыка ────────────────────────────────────────────────────────────
  const YA_TYPES = ['track', 'album', 'artist', 'playlist'];
  const yaType = (v: unknown): YmType => (YA_TYPES.includes(v as string) ? (v as YmType) : 'track');

  app.get('/api/ya/search', requireAuth, async (req, res) => {
    const q = String(req.query.q ?? '');
    if (!q.trim()) {
      res.json({ items: [] });
      return;
    }
    try {
      res.json({ items: await bot.yandexSearch(q, yaType(req.query.type)) });
    } catch {
      res.status(502).json({ items: [] });
    }
  });

  app.get('/api/ya/resolve', requireAuth, async (req, res) => {
    try {
      res.json({ item: await bot.yandexResolveToItem(String(req.query.url ?? '')) });
    } catch {
      res.json({ item: null });
    }
  });

  app.get('/api/ya/tracks', requireAuth, async (req, res) => {
    const id = String(req.query.id ?? '');
    if (!id) {
      res.status(400).json({ tracks: [] });
      return;
    }
    try {
      res.json({ tracks: await bot.yandexTracksFor(id, yaType(req.query.type)) });
    } catch {
      res.status(502).json({ tracks: [] });
    }
  });

  app.post('/api/ya/play', requireAuth, async (req, res) => {
    const b = (req.body ?? {}) as {
      channelId?: unknown;
      id?: unknown;
      type?: unknown;
      title?: unknown;
      artist?: unknown;
      durationMs?: unknown;
      coverUrl?: unknown;
      position?: unknown;
    };
    if (!b.channelId || !b.id) {
      res.status(400).json({ ok: false, message: 'Нужны channelId и id.' });
      return;
    }
    try {
      res.json(
        await bot.playYandex({
          channelId: String(b.channelId),
          id: String(b.id),
          type: yaType(b.type),
          title: typeof b.title === 'string' ? b.title : undefined,
          artist: typeof b.artist === 'string' ? b.artist : undefined,
          durationMs: typeof b.durationMs === 'number' ? b.durationMs : undefined,
          coverUrl: typeof b.coverUrl === 'string' ? b.coverUrl : undefined,
          position: b.position === 'next' ? 'next' : 'end',
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  // ── ВКонтакте ────────────────────────────────────────────────────────────────
  const VK_TYPES = ['track', 'playlist'];
  const vkType = (v: unknown): VkType => (VK_TYPES.includes(v as string) ? (v as VkType) : 'track');

  app.get('/api/vk/search', requireAuth, async (req, res) => {
    const q = String(req.query.q ?? '');
    if (!q.trim()) {
      res.json({ items: [] });
      return;
    }
    try {
      res.json({ items: await bot.vkSearch(q, vkType(req.query.type)) });
    } catch {
      res.status(502).json({ items: [] });
    }
  });

  app.get('/api/vk/resolve', requireAuth, async (req, res) => {
    try {
      res.json({ item: await bot.vkResolveToItem(String(req.query.url ?? '')) });
    } catch {
      res.json({ item: null });
    }
  });

  app.get('/api/vk/tracks', requireAuth, async (req, res) => {
    const id = String(req.query.id ?? '');
    if (!id) {
      res.status(400).json({ tracks: [] });
      return;
    }
    try {
      res.json({ tracks: await bot.vkTracksFor(id, vkType(req.query.type)) });
    } catch {
      res.status(502).json({ tracks: [] });
    }
  });

  app.post('/api/vk/play', requireAuth, async (req, res) => {
    const b = (req.body ?? {}) as {
      channelId?: unknown;
      id?: unknown;
      type?: unknown;
      title?: unknown;
      artist?: unknown;
      durationMs?: unknown;
      coverUrl?: unknown;
      position?: unknown;
    };
    if (!b.channelId || !b.id) {
      res.status(400).json({ ok: false, message: 'Нужны channelId и id.' });
      return;
    }
    try {
      res.json(
        await bot.playVk({
          channelId: String(b.channelId),
          id: String(b.id),
          type: vkType(b.type),
          title: typeof b.title === 'string' ? b.title : undefined,
          artist: typeof b.artist === 'string' ? b.artist : undefined,
          durationMs: typeof b.durationMs === 'number' ? b.durationMs : undefined,
          coverUrl: typeof b.coverUrl === 'string' ? b.coverUrl : undefined,
          position: b.position === 'next' ? 'next' : 'end',
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/queue/remove', requireAuth, (req, res) => {
    const index = Number((req.body as { index?: unknown })?.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.removeFromQueue(index) });
  });

  app.post('/api/queue/move', requireAuth, (req, res) => {
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.moveInQueue(from, to) });
  });

  app.post('/api/control/:action', requireAuth, (req, res) => {
    switch (req.params.action) {
      case 'pause':
        res.json({ paused: bot.togglePause() });
        return;
      case 'skip':
        res.json({ ok: bot.skip() });
        return;
      case 'stop':
        bot.stop();
        res.json({ ok: true });
        return;
      case 'shuffle':
        res.json({ count: bot.shuffle() });
        return;
      case 'leave':
        bot.leave();
        res.json({ ok: true });
        return;
      default:
        res.status(404).json({ error: 'unknown_action' });
    }
  });

  // ── Режим «Проигрывание в браузере» ──────────────────────────────────────────
  // Поиск (/api/search, /api/yt/search, /api/ya/search, /api/vk/search, /api/tracks,
  // /api/history) общий для обоих режимов — каналу не принадлежит, дублировать незачем.
  app.get('/api/browser/state', requireAuth, (_req, res) => {
    res.json(bot.browserGetState());
  });

  app.post('/api/browser/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; type?: unknown; position?: unknown };
    const type = VALID_TYPES.includes(body.type as SearchType) ? (body.type as SearchType) : 'album';
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.query) {
      res.status(400).json({ ok: false, message: 'Нужен query.' });
      return;
    }
    try {
      res.json(await bot.browserPlay({ query: String(body.query), type, position }));
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка воспроизведения.' });
    }
  });

  app.post('/api/browser/random', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { position?: unknown };
    const position = body.position === 'next' ? 'next' : 'end';
    try {
      res.json(await bot.browserPlayRandom({ position }));
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/browser/yt/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      videoId?: unknown;
      playlistUrl?: unknown;
      title?: unknown;
      channel?: unknown;
      durationMs?: unknown;
      position?: unknown;
    };
    const position = body.position === 'next' ? 'next' : 'end';
    try {
      if (typeof body.playlistUrl === 'string' && body.playlistUrl) {
        res.json(await bot.browserPlayYouTubePlaylist({ url: body.playlistUrl, position }));
        return;
      }
      if (!body.videoId) {
        res.status(400).json({ ok: false, message: 'Нужны videoId или playlistUrl.' });
        return;
      }
      res.json(
        await bot.browserPlayYouTube({
          videoId: String(body.videoId),
          title: typeof body.title === 'string' ? body.title : undefined,
          channel: typeof body.channel === 'string' ? body.channel : undefined,
          durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
          position,
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/browser/ya/play', requireAuth, async (req, res) => {
    const b = (req.body ?? {}) as {
      id?: unknown;
      type?: unknown;
      title?: unknown;
      artist?: unknown;
      durationMs?: unknown;
      coverUrl?: unknown;
      position?: unknown;
    };
    if (!b.id) {
      res.status(400).json({ ok: false, message: 'Нужен id.' });
      return;
    }
    try {
      res.json(
        await bot.browserPlayYandex({
          id: String(b.id),
          type: yaType(b.type),
          title: typeof b.title === 'string' ? b.title : undefined,
          artist: typeof b.artist === 'string' ? b.artist : undefined,
          durationMs: typeof b.durationMs === 'number' ? b.durationMs : undefined,
          coverUrl: typeof b.coverUrl === 'string' ? b.coverUrl : undefined,
          position: b.position === 'next' ? 'next' : 'end',
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/browser/vk/play', requireAuth, async (req, res) => {
    const b = (req.body ?? {}) as {
      id?: unknown;
      type?: unknown;
      title?: unknown;
      artist?: unknown;
      durationMs?: unknown;
      coverUrl?: unknown;
      position?: unknown;
    };
    if (!b.id) {
      res.status(400).json({ ok: false, message: 'Нужен id.' });
      return;
    }
    try {
      res.json(
        await bot.browserPlayVk({
          id: String(b.id),
          type: vkType(b.type),
          title: typeof b.title === 'string' ? b.title : undefined,
          artist: typeof b.artist === 'string' ? b.artist : undefined,
          durationMs: typeof b.durationMs === 'number' ? b.durationMs : undefined,
          coverUrl: typeof b.coverUrl === 'string' ? b.coverUrl : undefined,
          position: b.position === 'next' ? 'next' : 'end',
        }),
      );
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/browser/history/play', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; position?: unknown };
    const position = body.position === 'next' ? 'next' : 'end';
    if (!body.id) {
      res.status(400).json({ ok: false, message: 'Нужен id.' });
      return;
    }
    try {
      res.json(await bot.browserPlayFromHistory(String(body.id), position));
    } catch {
      res.status(500).json({ ok: false, message: 'Ошибка.' });
    }
  });

  app.post('/api/browser/queue/remove', requireAuth, (req, res) => {
    const index = Number((req.body as { index?: unknown })?.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.browserRemoveFromQueue(index) });
  });

  app.post('/api/browser/queue/move', requireAuth, (req, res) => {
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.browserMoveInQueue(from, to) });
  });

  app.post('/api/browser/seek', requireAuth, (req, res) => {
    const body = (req.body ?? {}) as { positionMs?: unknown };
    const positionMs = Number(body.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: bot.browserSeek(positionMs) });
  });

  app.post('/api/browser/control/:action', requireAuth, (req, res) => {
    switch (req.params.action) {
      case 'pause':
        res.json({ paused: bot.browserTogglePlaying() });
        return;
      case 'skip':
        res.json({ ok: bot.browserSkip() });
        return;
      case 'stop':
        bot.browserStop();
        res.json({ ok: true });
        return;
      case 'shuffle':
        res.json({ count: bot.browserShuffle() });
        return;
      default:
        res.status(404).json({ error: 'unknown_action' });
    }
  });

  // Живой MP3-стрим текущего трека браузерного плеера. requireAuth — та же сессия,
  // что и у остального API (иначе поток слушал бы кто угодно по прямой ссылке).
  app.get('/api/browser/stream', requireAuth, (req, res) => {
    const playId = String(req.query.play ?? '');
    if (!playId || !bot.browserAttachStream(res, playId)) {
      res.status(404).end();
    }
    // На успехе заголовки/подписку на fan-out уже сделал browserAttachStream — ответ
    // держим открытым, res.end() вызовет BrowserPlayer при остановке/смене трека.
  });

  // ── Прокси обложек (ключ Jellyfin остаётся на сервере) ───────────────────────
  app.get('/art/:id', requireAuth, async (req, res) => {
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const h = Number(req.query.h ?? 256);
    try {
      const upstream = await bot.jellyfin.fetchImage(
        String(req.params.id),
        tag,
        Number.isFinite(h) ? h : 256,
      );
      if (!upstream.ok) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).end();
    }
  });

  // ── Админ-страницы: без входа в админку — на главную ─────────────────────────
  const adminPage: express.RequestHandler = (req, res, next) => {
    if (req.session?.authed && req.session?.admin) {
      next();
      return;
    }
    res.redirect('/');
  };
  app.get('/cert.html', adminPage, (_req, res) => res.sendFile(path.join(UI_DIR, 'cert.html')));
  app.get('/logs.html', adminPage, (_req, res) => res.sendFile(path.join(UI_DIR, 'logs.html')));

  // ── Статика панели ──────────────────────────────────────────────────────────
  app.use(express.static(UI_DIR));

  app.listen(panel.port, '127.0.0.1', () => {
    logger.info(
      `Веб-панель слушает http://127.0.0.1:${panel.port} ` +
        `(проксируй сюда ds.starald.ru через nginx).`,
    );
  });
}
