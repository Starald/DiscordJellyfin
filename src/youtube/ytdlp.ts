import { execFile } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

function findYtDlp(): string {
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe',
    ),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'yt-dlp';
}

const YT_DLP = process.env.YT_DLP_PATH ?? findYtDlp();

/** Последние N непустых строк текста — для компактного лога stderr yt-dlp. */
function tail(text: string, lines = 6): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' ⏎ ');
}

/** ISO 8601 длительность (PT3M44S) → миллисекунды. */
function parseDuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}

/** Извлечь 11-символьный id видео из ссылки YouTube. */
function extractVideoId(url: string): string | null {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = p.exec(url);
    if (m) return m[1]!;
  }
  return null;
}

export interface YtVideo {
  id: string;
  title: string;
  channel?: string;
  durationMs: number;
}

interface RawEntry {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  duration?: unknown;
  entries?: RawEntry[];
}

export class YouTube {
  constructor(
    private readonly cookiesPath?: string,
    private readonly proxy?: string,
    private readonly apiKey?: string,
    /** Браузер для живых куки (firefox/chrome/edge). Имеет приоритет над файлом. */
    private readonly cookiesFromBrowser?: string,
  ) {}

  private commonArgs(): string[] {
    // --no-warnings УБРАН намеренно: предупреждения yt-dlp (анти-бот, PO-token, «формат
    // недоступен») уходят в stderr и нужны для диагностики. Их логирует run().
    const args: string[] = [];
    if (this.proxy) args.push('--proxy', this.proxy);
    return args;
  }

  /**
   * Куки нужны только для извлечения аудио (анти-бот). Поиск без них быстрее.
   * ВАЖНО: yt-dlp перезаписывает файл куки после запуска (сохраняет ротированную
   * сессию YouTube), из-за чего куки деградируют и быстро умирают. Поэтому отдаём
   * yt-dlp ОДНОРАЗОВУЮ КОПИЮ, а оригинал остаётся нетронутым и живёт долго.
   */
  private cookieArgs(): string[] {
    // Живые куки из браузера — всегда свежие, ручной экспорт не нужен.
    if (this.cookiesFromBrowser) return ['--cookies-from-browser', this.cookiesFromBrowser];
    if (!this.cookiesPath || !existsSync(this.cookiesPath)) return [];
    const working = path.join(os.tmpdir(), 'ytdlp-cookies-working.txt');
    try {
      copyFileSync(this.cookiesPath, working);
      return ['--cookies', working];
    } catch {
      // если копия не удалась — лучше не трогать оригинал
      return [];
    }
  }

  private async run(args: string[], label: string): Promise<string> {
    const started = Date.now();
    // Прокси/куки-режим — без содержимого куки; ничего секретного в args нет.
    logger.info(`[yt-dlp] ${label}${this.proxy ? ' (через прокси)' : ''} → запуск`);
    try {
      const { stdout, stderr } = await execFileAsync(YT_DLP, args, {
        maxBuffer: 32 * 1024 * 1024,
      });
      const ms = Date.now() - started;
      const warn = (stderr ?? '').trim();
      if (warn) logger.warn(`[yt-dlp] ${label}: предупреждения — ${tail(warn)}`);
      logger.info(`[yt-dlp] ${label}: успех за ${ms} мс`);
      return stdout;
    } catch (err) {
      const ms = Date.now() - started;
      const e = err as { stderr?: string; message?: string; code?: number | string };
      const detail = tail(((e.stderr ?? '') || e.message || '').trim()) || 'нет вывода';
      logger.error(`[yt-dlp] ${label}: ОШИБКА за ${ms} мс (exit=${e.code ?? '?'}) — ${detail}`);
      throw err;
    }
  }

  private toVideos(entries: RawEntry[]): YtVideo[] {
    return entries
      .filter((e) => typeof e.id === 'string' && (e.id as string).length === 11)
      .map((e) => ({
        id: e.id as string,
        title: typeof e.title === 'string' ? e.title : (e.id as string),
        channel:
          typeof e.channel === 'string'
            ? e.channel
            : typeof e.uploader === 'string'
              ? e.uploader
              : undefined,
        durationMs: Math.round((Number(e.duration) || 0) * 1000),
      }));
  }

  /** Поиск по названию или разбор ссылки. Возвращает список видео. */
  async resolve(input: string, limit = 20): Promise<YtVideo[]> {
    const trimmed = input.trim();
    if (!trimmed) return [];
    const isUrl = /^https?:\/\//i.test(trimmed);
    const target = isUrl ? trimmed : `ytsearch${limit}:${trimmed}`;

    let stdout: string;
    try {
      // Куки нужны и для поиска: на флагнутых IP (РФ) без них YouTube режет анти-ботом.
      // Через одноразовую копию (cookieArgs) — оригинал не деградирует.
      stdout = await this.run(
        [...this.commonArgs(), ...this.cookieArgs(), '--flat-playlist', '-J', target],
        `поиск/разбор «${isUrl ? trimmed : input.trim()}»`,
      );
    } catch (err) {
      logger.warn('yt-dlp resolve error:', err instanceof Error ? err.message : err);
      return [];
    }

    let json: RawEntry;
    try {
      json = JSON.parse(stdout) as RawEntry;
    } catch {
      return [];
    }
    if (Array.isArray(json.entries)) return this.toVideos(json.entries);
    if (typeof json.id === 'string') return this.toVideos([json]);
    return [];
  }

  /**
   * Быстрый поиск через YouTube Data API v3 (не зависит от IP-репутации).
   * Возвращает null, если API недоступен/не применим (нет ключа, ошибка, квота,
   * непонятная ссылка) — тогда вызывающий откатывается на yt-dlp.
   */
  async searchViaApi(input: string, limit = 15): Promise<YtVideo[] | null> {
    if (!this.apiKey) return null;
    const trimmed = input.trim();
    if (!trimmed) return [];

    try {
      const vid = extractVideoId(trimmed);
      if (vid) return await this.apiVideos([vid]);
      // непонятная ссылка (плейлист/канал) → пусть разбирает yt-dlp
      if (/^https?:\/\//i.test(trimmed)) return null;

      const ids = await this.apiSearchIds(trimmed, limit);
      if (ids.length === 0) return [];
      return await this.apiVideos(ids);
    } catch (err) {
      logger.warn('YouTube Data API error:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async apiSearchIds(q: string, limit: number): Promise<string[]> {
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
      `&maxResults=${limit}&q=${encodeURIComponent(q)}&key=${this.apiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`search.list ${r.status}`);
    const j = (await r.json()) as { items?: { id?: { videoId?: string } }[] };
    return (j.items ?? [])
      .map((i) => i.id?.videoId)
      .filter((x): x is string => typeof x === 'string');
  }

  private async apiVideos(ids: string[]): Promise<YtVideo[]> {
    if (ids.length === 0) return [];
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails` +
      `&id=${ids.join(',')}&key=${this.apiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`videos.list ${r.status}`);
    const j = (await r.json()) as {
      items?: {
        id?: string;
        snippet?: { title?: string; channelTitle?: string };
        contentDetails?: { duration?: string };
      }[];
    };
    const byId = new Map<string, YtVideo>();
    for (const it of j.items ?? []) {
      if (!it.id) continue;
      byId.set(it.id, {
        id: it.id,
        title: it.snippet?.title ?? it.id,
        channel: it.snippet?.channelTitle,
        durationMs: parseDuration(it.contentDetails?.duration ?? ''),
      });
    }
    return ids.map((id) => byId.get(id)).filter((v): v is YtVideo => v !== undefined);
  }

  /** Прямой аудио-URL для воспроизведения (на момент запуска трека). */
  async getAudioUrl(videoId: string): Promise<string> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // Извлечение аудио — с куки (обход анти-бот проверки).
    const stdout = await this.run(
      [...this.commonArgs(), ...this.cookieArgs(), '-f', 'bestaudio', '-g', url],
      `аудио-URL ${videoId}`,
    );
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) throw new Error('yt-dlp не вернул аудио-URL');
    return first;
  }

  /** Инфо одного видео по id: быстрый путь через Data API, иначе yt-dlp. */
  async getVideoInfo(id: string): Promise<YtVideo | null> {
    if (this.apiKey) {
      try {
        const vs = await this.apiVideos([id]);
        if (vs[0]) return vs[0];
      } catch {
        /* падаем в yt-dlp */
      }
    }
    const vs = await this.resolve(`https://www.youtube.com/watch?v=${id}`, 1);
    return vs[0] ?? null;
  }

  /** Плейлист: название + список видео (flat-playlist). */
  async getPlaylist(url: string): Promise<{ title: string; videos: YtVideo[] }> {
    let stdout: string;
    try {
      stdout = await this.run(
        [...this.commonArgs(), ...this.cookieArgs(), '--flat-playlist', '-J', url],
        `плейлист ${url}`,
      );
    } catch (err) {
      logger.warn('yt-dlp playlist error:', err instanceof Error ? err.message : err);
      return { title: '', videos: [] };
    }
    let json: RawEntry & { title?: unknown };
    try {
      json = JSON.parse(stdout) as RawEntry & { title?: unknown };
    } catch {
      return { title: '', videos: [] };
    }
    const entries = Array.isArray(json.entries) ? json.entries : [];
    return {
      title: typeof json.title === 'string' ? json.title : 'Плейлист',
      videos: this.toVideos(entries),
    };
  }

  /** Разобрать ссылку: с list= → плейлист (коллекция), иначе одиночное видео. */
  async resolveUrl(
    url: string,
  ): Promise<
    | { kind: 'playlist'; id: string; title: string; count: number; thumbId?: string }
    | { kind: 'video'; video: YtVideo }
    | null
  > {
    const listId = /[?&]list=([A-Za-z0-9_-]+)/.exec(url)?.[1];
    if (listId) {
      const pl = await this.getPlaylist(url);
      if (pl.videos.length === 0) return null;
      return {
        kind: 'playlist',
        id: url,
        title: pl.title,
        count: pl.videos.length,
        thumbId: pl.videos[0]?.id,
      };
    }
    const vid = extractVideoId(url);
    if (!vid) return null;
    const video = await this.getVideoInfo(vid);
    return video ? { kind: 'video', video } : null;
  }
}
