import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import prism from 'prism-media';
import { logger } from '../logger.js';
import type { Track } from './track.js';

export interface BrowserNowPlaying {
  track: Track;
  playbackMs: number;
  paused: boolean;
  buffering: boolean;
  /** Id текущего "физического" прогона стрима — меняется на старте/резюме/сике трека.
   *  Клиент триггерит новый <audio src> при смене playId (см. /api/browser/stream). */
  playId: string;
}

export interface BrowserQueueSnapshot {
  current: Track | null;
  upcoming: Track[];
  paused: boolean;
}

const MP3_BITRATE = '320k';

/**
 * Плеер "воспроизведение в браузере" — та же модель очереди, что у GuildMusicPlayer
 * (audio/player.ts), но без Discord вообще: вместо голосового подключения — живой
 * MP3-стрим по HTTP (см. server.ts: GET /api/browser/stream).
 *
 * Аудио-пайплайн: тот же источник (Jellyfin/YouTube/Яндекс/ВК) → FFmpeg (-re, libmp3lame) →
 * fan-out во все подключённые HTTP-ответы. -re держит темп кодирования равным реальному
 * времени (иначе браузер вмиг скачал бы весь трек, и пауза потеряла бы смысл).
 *
 * Флажок «воспроизводить музыку» на странице — это `paused` наоборот: пока он выключен,
 * enqueue() просто копит очередь и ничего не запускает.
 */
export class BrowserPlayer {
  private queue: Track[] = [];
  private current: Track | null = null;
  private currentTranscoder: prism.FFmpeg | null = null;
  private readonly listeners = new Set<ServerResponse>();
  private playId: string | null = null;
  /** Смещение начала текущего прогона (мс) — при паузе/сике FFmpeg перезапускается с -ss. */
  private seekOffsetMs = 0;
  /** Date.now() момента запуска текущего прогона — для расчёта playbackMs без опроса FFmpeg. */
  private startedAt = 0;
  private firstByteReceived = false;
  private loopOne = false;
  private suppressLoop = false;
  private destroyed = false;
/** true — очередь на паузе (глобально, для всех окон). Управляется кнопкой «пауза»,
 *  не флажком «слушать в этом окне» — тот теперь чисто клиентский, см. app.js. */
  private paused = false;

  // ── Очередь ──────────────────────────────────────────────────────────────

  enqueue(tracks: Track[], position: 'end' | 'next' = 'end'): void {
    if (position === 'next') this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    this.prefetchNext();
    // Флажок уже включён и сейчас простой — запускаем сразу (как start() у Discord-плеера).
    if (!this.paused && !this.current) void this.playNext();
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

  /** Переключить флажок «воспроизводить музыку». Возвращает новое состояние paused. */
  togglePlaying(): boolean {
    if (this.paused) {
      this.paused = false;
      if (this.current) this.startTranscoder(this.current, this.seekOffsetMs);
      else void this.playNext(); // очередь копилась без проигрывания — запускаем голову
    } else {
      // Фиксируем позицию на момент паузы, чтобы включение продолжило именно отсюда.
      if (this.current) this.seekOffsetMs = this.currentPlaybackMs();
      this.paused = true;
      this.stopTranscoder();
    }
    return this.paused;
  }

  skip(): boolean {
    if (!this.current && this.queue.length === 0) return false;
    this.suppressLoop = true; // скип не должен повторять текущий трек
    this.stopTranscoder();
    void this.playNext();
    return true;
  }

  stop(): void {
    this.queue = [];
    this.suppressLoop = true;
    this.current = null;
    this.playId = null;
    this.paused = true;
    this.stopTranscoder();
  }

  /** Перемотать текущий трек на позицию (мс); неявно продолжает воспроизведение. */
  seek(positionMs: number): boolean {
    if (!this.current) return false;
    const clamped = Math.max(0, Math.min(positionMs, Math.max(0, this.current.durationMs - 1000)));
    this.paused = false;
    this.startTranscoder(this.current, clamped);
    return true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isActive(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  getSnapshot(): BrowserQueueSnapshot {
    return { current: this.current, upcoming: [...this.queue], paused: this.paused };
  }

  getNowPlaying(): BrowserNowPlaying | null {
    if (!this.current || !this.playId) return null;
    return {
      track: this.current,
      playbackMs: this.currentPlaybackMs(),
      paused: this.paused,
      buffering: this.isLoading,
      playId: this.playId,
    };
  }

  /** Трек выбран, но байты ещё не пошли (резолв URL источника либо FFmpeg только стартует). */
  get isLoading(): boolean {
    if (!this.current) return false;
    return !this.currentTranscoder || !this.firstByteReceived;
  }

  private currentPlaybackMs(): number {
    if (this.paused || !this.currentTranscoder) return this.seekOffsetMs;
    return this.seekOffsetMs + (Date.now() - this.startedAt);
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
    if (this.destroyed || this.paused) return;
    this.stopTranscoder();

    const finished = this.current;
    const loop = this.loopOne && !this.suppressLoop;
    this.suppressLoop = false;
    if (loop && finished) this.queue.unshift(finished);

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.playId = null;
      return;
    }

    this.current = next;
    try {
      await this.ensureResolved(next);
      this.startTranscoder(next, 0);
      this.prefetchNext();
    } catch (err) {
      logger.error(`[browser] Не удалось создать поток для "${next.title}":`, err);
      this.current = null;
      await this.playNext();
    }
  }

  // ── FFmpeg → MP3 → HTTP ──────────────────────────────────────────────────

  private startTranscoder(track: Track, startMs: number): void {
    // КРИТИЧНО: убить предыдущий прогон (если был) ДО старта нового. Раньше seek()/resume
    // просто перезаписывали this.currentTranscoder новым процессом, а старый молча продолжал
    // работать и писать байты в те же listeners — два FFmpeg одновременно в один HTTP-поток
    // давали характерный баг «перемотка ломает звук, играет пробелами» (перемешанные MP3-байты
    // от двух процессов). Плюс явно закрываем прежних слушателей: они подписаны на байты
    // прошлого прогона, а не нового, и их «зависший» коннект тоже нужно оборвать.
    this.stopTranscoder();
    for (const res of this.listeners) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.listeners.clear();
    this.playId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.seekOffsetMs = startMs;
    this.firstByteReceived = false;

    const args = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    if (track.proxy) args.push('-http_proxy', track.proxy);
    // -re — кодировать в реальном темпе (а не «взахлёб»): иначе клиент вмиг скачает весь
    // трек и серверная пауза/сик перестанут что-либо значить (см. заголовок класса).
    args.push('-re');
    if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3));
    args.push(
      '-i', track.streamUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-vn',
      '-ar', '44100',
      '-ac', '2',
      '-c:a', 'libmp3lame',
      '-b:a', MP3_BITRATE,
      '-f', 'mp3',
    );

    const transcoder = new prism.FFmpeg({ args });
    transcoder.on('error', (err: Error) => {
      logger.warn(`[browser] FFmpeg error на "${track.title}": ${err.message}`);
    });
    transcoder.on('data', (chunk: Buffer) => {
      this.firstByteReceived = true;
      for (const res of this.listeners) {
        // Backpressure сознательно игнорируем: личный сервер, слушателей мало, а копить
        // очередь записи на медленном клиенте хуже, чем изредка отстать на кадр-другой.
        res.write(chunk);
      }
    });
    transcoder.on('end', () => {
      if (this.destroyed || this.paused) return;
      void this.playNext();
    });
    this.currentTranscoder = transcoder;
  }

  private stopTranscoder(): void {
    try {
      this.currentTranscoder?.destroy();
    } catch {
      /* ignore */
    }
    this.currentTranscoder = null;
  }

  // ── HTTP-стрим (см. server.ts: GET /api/browser/stream) ─────────────────

  /**
   * Подписать HTTP-ответ на текущий живой поток. false, если playId не совпадает с текущим
   * (например, клиент запросил уже сменившийся трек) — сервер отвечает 404, клиент сам
   * перезапросит свежее состояние на следующем poll().
   */
  attachListener(res: ServerResponse, requestedPlayId: string): boolean {
    if (!this.playId || requestedPlayId !== this.playId) return false;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    this.listeners.add(res);
    res.on('close', () => this.listeners.delete(res));
    return true;
  }

  /** Полная остановка (например, при завершении процесса бота). */
  destroy(): void {
    this.destroyed = true;
    this.stop();
    for (const res of this.listeners) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.listeners.clear();
  }
}
