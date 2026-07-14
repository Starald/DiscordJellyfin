import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type { Track } from './track.js';

export interface BrowserNowPlaying {
  track: Track;
  /**
   * Токен текущего трека — меняется при каждой смене трека. `null`, пока стрим-URL ещё
   * резолвится (у YouTube/ВК/Яндекс это занимает время): клиент грузит <audio> только
   * после появления токена, а до этого показывает трек в состоянии «загрузка».
   */
  playToken: string | null;
  /** true — трек выбран, но стрим-URL ещё не готов (идёт резолв). */
  buffering: boolean;
  /**
   * true — источник отдаёт HLS-манифест (.m3u8), а не готовый прогрессивный файл.
   * Обычный <audio> в Chrome/Firefox HLS не играет — клиент подключает hls.js,
   * а сервер переписывает манифест и проксирует сегменты (см. web/server.ts).
   */
  hls: boolean;
}

/** Похож ли стрим-URL на HLS-манифест (плейлист .m3u8). */
export function isHlsUrl(url: string | undefined): boolean {
  return !!url && /\.m3u8(\?|$)/i.test(url);
}

export interface BrowserQueueSnapshot {
  current: Track | null;
  upcoming: Track[];
}

/** Цель проксирования для текущего трека: реальный upstream-URL + прокси для fetch. */
export interface BrowserStreamTarget {
  url: string;
  /** HTTP(S)-прокси, через который надо тянуть upstream (ВК/Яндекс/YouTube). */
  proxy?: string;
  /** true — этот upstream отдаёт HLS-манифест (сервер обязан его переписать, а не лить как есть). */
  hls: boolean;
}

/**
 * Плеер «воспроизведение в браузере»: та же модель очереди, что у GuildMusicPlayer
 * (audio/player.ts), но без Discord и, главное, БЕЗ FFmpeg. Сервер лишь держит очередь,
 * выбирает «текущий» трек и резолвит его настоящий стрим-URL источника. Байты отдаёт
 * не он сам, а тонкий Range-прокси в web/server.ts (GET /api/browser/stream), который
 * перекидывает оригинальный поток источника в браузер как есть — без перекодирования.
 *
 * Управление воспроизведением (play/pause/перемотка/громкость) теперь НАТИВНОЕ, на стороне
 * <audio> в браузере: сервер этим не занимается. Когда трек доиграл, клиент сообщает об этом
 * (POST /api/browser/ended с токеном) — и сервер продвигает очередь. Дедуп по токену не даёт
 * нескольким окнам продвинуть очередь дважды.
 */
export class BrowserPlayer {
  private queue: Track[] = [];
  private current: Track | null = null;
  /** Токен текущего трека; `null`, пока URL не зарезолвен (клиент ждёт его перед загрузкой). */
  private playToken: string | null = null;
  private loopOne = false;
  private suppressLoop = false;
  private destroyed = false;
  private readonly onTrackStart?: (track: Track) => void;

  constructor(opts?: { onTrackStart?: (track: Track) => void }) {
    this.onTrackStart = opts?.onTrackStart;
  }

  // ── Очередь ──────────────────────────────────────────────────────────────

  enqueue(tracks: Track[], position: 'end' | 'next' = 'end'): void {
    if (position === 'next') this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    this.prefetchNext();
    // Ничего не играет — делаем голову «текущей» (клиент сам решит, запускать ли звук:
    // без пользовательского жеста браузер не даст .play(), это нормально).
    if (!this.current) void this.playNext();
  }

  removeAt(index: number): Track | null {
    if (index < 0 || index >= this.queue.length) return null;
    const [removed] = this.queue.splice(index, 1);
    this.prefetchNext();
    return removed ?? null;
  }

  moveTrack(from: number, to: number): boolean {
    if (from < 0 || from >= this.queue.length) return false;
    if (to < 0 || to >= this.queue.length) return false;
    if (from === to) return true;
    const [item] = this.queue.splice(from, 1);
    if (!item) return false;
    this.queue.splice(to, 0, item);
    this.prefetchNext();
    return true;
  }

  shuffle(): number {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
    this.prefetchNext();
    return this.queue.length;
  }

  toggleLoop(): boolean {
    this.loopOne = !this.loopOne;
    return this.loopOne;
  }

  get isLooping(): boolean {
    return this.loopOne;
  }

  // ── Команды управления ───────────────────────────────────────────────────

  /** Следующий трек (общий для всех окон — двигает единую очередь). */
  skip(): boolean {
    if (!this.current && this.queue.length === 0) return false;
    this.suppressLoop = true; // скип не должен повторять текущий трек
    void this.playNext();
    return true;
  }

  stop(): void {
    this.queue = [];
    this.suppressLoop = true;
    this.current = null;
    this.playToken = null;
  }

  get isActive(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  getSnapshot(): BrowserQueueSnapshot {
    return { current: this.current, upcoming: [...this.queue] };
  }

  getNowPlaying(): BrowserNowPlaying | null {
    if (!this.current) return null;
    return {
      track: this.current,
      playToken: this.playToken,
      buffering: !this.playToken, // токена ещё нет → идёт резолв URL
      // ВК всегда отдаёт HLS → гоним его через hls.js всегда, не полагаясь на вид URL.
      hls: this.current.source === 'vk' || isHlsUrl(this.current.streamUrl),
    };
  }

  // ── Стрим-таргет и завершение трека (для web/server.ts) ────────────────────

  /**
   * Цель проксирования для текущего прогона. `null`, если токен устарел (клиент запросил
   * уже сменившийся трек) либо URL ещё не готов — тогда сервер отвечает 404, а клиент
   * подхватит свежее состояние на следующем poll().
   */
  getStreamTarget(token: string): BrowserStreamTarget | null {
    if (!this.current || !this.playToken || token !== this.playToken) return null;
    if (!this.current.streamUrl) return null;
    return {
      url: this.current.streamUrl,
      proxy: this.current.proxy,
      hls: this.current.source === 'vk' || isHlsUrl(this.current.streamUrl),
    };
  }

  /**
   * Клиент сообщил, что <audio> доиграл трек с этим токеном → продвигаем очередь.
   * Проверка токена делает вызов идемпотентным: второе окно с тем же (уже устаревшим)
   * токеном очередь повторно не двинет.
   */
  reportEnded(token: string): boolean {
    if (!this.playToken || token !== this.playToken) return false;
    void this.playNext();
    return true;
  }

  // ── Резолв стрим-URL (как в GuildMusicPlayer — мемоизация + предзагрузка головы) ────

  private ensureResolved(track: Track): Promise<void> {
    if (!track.resolve || track.streamUrl) return Promise.resolve();
    if (!track.resolving) {
      track.prefetchState = 'loading';
      track.resolving = (async () => {
        try {
          track.streamUrl = await track.resolve!();
          track.prefetchState = 'ready';
        } catch (err) {
          track.prefetchState = 'error';
          track.resolving = undefined;
          throw err;
        }
      })();
    }
    return track.resolving;
  }

  private prefetchNext(): void {
    const head = this.queue[0];
    if (head && head.resolve && !head.streamUrl) {
      void this.ensureResolved(head).catch(() => {
        /* реальную ошибку покажем/повторим при старте трека */
      });
    }
  }

  private async playNext(): Promise<void> {
    if (this.destroyed) return;

    const finished = this.current;
    const loop = this.loopOne && !this.suppressLoop;
    this.suppressLoop = false;
    if (loop && finished) this.queue.unshift(finished);

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.playToken = null;
      return;
    }

    // Токен обнуляем сразу: пока URL не готов, /stream отдаёт 404, а клиент видит «загрузка».
    this.current = next;
    this.playToken = null;

    try {
      await this.ensureResolved(next);
      // Пока резолвили, трек мог смениться (skip/stop/новый playNext) — тогда молча выходим.
      if (this.current !== next) return;
      this.playToken = crypto.randomUUID();
      this.onTrackStart?.(next);
      this.prefetchNext();
    } catch (err) {
      logger.error(`[browser] Не удалось получить поток для "${next.title}":`, err);
      if (this.current === next) {
        this.current = null;
        await this.playNext();
      }
    }
  }

  /** Полная остановка (например, при завершении процесса бота). */
  destroy(): void {
    this.destroyed = true;
    this.stop();
  }
}
