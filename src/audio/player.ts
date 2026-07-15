import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { logger } from '../logger.js';
import type { Track } from './track.js';

export interface NowPlaying {
  track: Track;
  /** Сколько уже проиграно текущего трека, мс. */
  playbackMs: number;
  paused: boolean;
  /** Идёт загрузка/буферизация (получение URL или старт FFmpeg), звук ещё не пошёл. */
  buffering: boolean;
}

/** Лёгкая (сериализуемая) запись истории — без функций resolve. */
export interface HistoryItem {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
  thumbUrl?: string;
  imageUrl?: string;
  albumId?: string;
}

export interface QueueSnapshot {
  current: Track | null;
  upcoming: Track[];
  paused: boolean;
}

/**
 * Плеер одной гильдии: держит голосовое подключение, очередь и AudioPlayer.
 * Аудио-пайплайн: Jellyfin (direct stream) → FFmpeg (libopus, ogg) → Discord.
 * Opus кодирует FFmpeg, поэтому opusscript не на горячем пути.
 */
export class GuildMusicPlayer {
  readonly guildId: string;
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private queue: Track[] = [];
  private current: Track | null = null;
  private currentResource: AudioResource<Track> | null = null;
  private currentTranscoder: prism.FFmpeg | null = null;
  /** Смещение начала текущего ресурса (мс) — при перемотке FFmpeg стартует с -ss. */
  private seekOffsetMs = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  /** Режим повтора текущего трека. */
  private loopOne = false;
  /** Разовый флаг: не повторять трек на этом переходе (skip/stop). */
  private suppressLoop = false;
  private pauseNext = false;
  /** История недавно проигранных треков (свежие — в начале). */
  private history: HistoryItem[] = [];
  /** Колбэк при изменении истории (для сохранения на диск). */
  private readonly onHistoryChange?: (history: HistoryItem[]) => void;

  constructor(
    guildId: string,
    private readonly idleTimeoutMs: number,
    /** Колбэк для удаления плеера из менеджера при выходе. */
    private readonly onLeave: (guildId: string) => void,
    opts?: { history?: HistoryItem[]; onHistoryChange?: (history: HistoryItem[]) => void },
  ) {
    this.guildId = guildId;
    if (opts?.history) this.history = [...opts.history];
    this.onHistoryChange = opts?.onHistoryChange;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.attachPlayerEvents();
  }

  // ── Подключение ──────────────────────────────────────────────────────────

  /** Подключается к голосовому каналу (или переезжает в другой). */
  connect(channel: VoiceBasedChannel): void {
    if (this.connection && this.connection.joinConfig.channelId === channel.id) return;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    this.attachConnectionEvents(this.connection);
  }

  /** Ждёт, пока подключение перейдёт в Ready (иначе бросает по таймауту). */
  async ensureReady(timeoutMs = 20_000): Promise<void> {
    if (!this.connection) throw new Error('Нет голосового подключения');
    await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
  }

  get channelId(): string | null {
    return this.connection?.joinConfig.channelId ?? null;
  }

  // ── Очередь и воспроизведение ────────────────────────────────────────────

  enqueue(tracks: Track[], position: 'end' | 'next' = 'end'): void {
    if (position === 'next') this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (this.queue.length > 0 || this.current) this.clearIdleTimer();
    this.prefetchNext();
  }

  /** Удалить трек из очереди по индексу (в upcoming). Возвращает удалённый трек. */
  removeAt(index: number): Track | null {
    if (index < 0 || index >= this.queue.length) return null;
    const [removed] = this.queue.splice(index, 1);
    this.prefetchNext();
    return removed ?? null;
  }

  /** Переместить трек в очереди с позиции from на to. */
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

  /** Запускает воспроизведение, если сейчас ничего не играет. */
  async start(): Promise<void> {
    if (this.current) return;
    await this.playNext();
  }

  private async playNext(): Promise<void> {
    if (this.destroyed) return;
    // Глушим FFmpeg прошлого трека — иначе процесс висит осиротевшим до самозавершения
    // (особенно при skip). На естественном завершении он уже вышел — destroy() безвреден.
    try {
      this.currentTranscoder?.destroy();
    } catch {
      /* ignore */
    }
    this.currentTranscoder = null;
    // Повтор: естественно завершившийся трек возвращаем в начало очереди.
    // skip()/stop() ставят suppressLoop, чтобы повтор не мешал им.
    const finished = this.current;
    const loop = this.loopOne && !this.suppressLoop;
    this.suppressLoop = false;
    if (loop && finished) this.queue.unshift(finished);

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.currentResource = null;
      this.startIdleTimer();
      return;
    }

    this.current = next;
    this.seekOffsetMs = 0;
    // Сбрасываем до resolve(): пока тянем URL — это «загрузка», а playbackMs = 0,
    // а не остаток от прошлого (уже завершённого) ресурса.
    this.currentResource = null;
    try {
      // YouTube/ВК/Яндекс: прямой URL добываем лениво (yt-dlp/API). ensureResolved переиспользует
      // уже выполненную предзагрузку (prefetch) головы очереди — тогда старт мгновенный.
      await this.ensureResolved(next);
      const resource = this.createResource(next);
      this.currentResource = resource;
      this.player.play(resource);
      if (this.pauseNext) {
        this.player.pause(true);
        this.pauseNext = false;
      }
      this.clearIdleTimer();
      this.recordHistory(next);
      // Голова очереди стала следующей — начинаем готовить её заранее, пока играет текущий.
      this.prefetchNext();
    } catch (err) {
      logger.error(`[${this.guildId}] Не удалось создать ресурс для "${next.title}":`, err);
      this.current = null;
      this.currentResource = null;
      await this.playNext();
    }
  }

  /**
   * Получить стрим-URL трека (мемоизировано). Если уже резолвили — переиспользуем результат;
   * если резолв идёт прямо сейчас (предзагрузка) — дожидаемся его, а не запускаем второй.
   * Для Jellyfin (нет resolve, streamUrl уже задан) — мгновенный no-op.
   */
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
          track.resolving = undefined; // дать повторную попытку при реальном старте
          throw err;
        }
      })();
    }
    return track.resolving;
  }

  /** Заранее подготовить (зарезолвить) первый трек в очереди — фоном, ошибки не критичны. */
  private prefetchNext(): void {
    const head = this.queue[0];
    if (head && head.resolve && !head.streamUrl) {
      void this.ensureResolved(head).catch(() => {
        /* реальную ошибку покажем/повторим при старте трека */
      });
    }
  }

  private createResource(track: Track, startMs = 0): AudioResource<Track> {
    // -reconnect* — устойчивость к коротким сетевым обрывам при чтении из Jellyfin.
    const args = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    // Прокси для ВК/Яндекса (если прямой путь до их CDN не работает без VPN).
    if (track.proxy) args.push('-http_proxy', track.proxy);
    // -ss перед -i — быстрая перемотка по входу (для seek).
    if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3));
    args.push(
      '-i', track.streamUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-vn',
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'libopus',
      '-b:a', '160k',
      '-f', 'ogg',
    );

    const transcoder = new prism.FFmpeg({ args });
    // Чтобы необработанный 'error' стрима не уронил процесс. На WARN — видно в логе.
    transcoder.on('error', (err: Error) => {
      logger.warn(`[${this.guildId}] FFmpeg error на "${track.title}": ${err.message}`);
    });
    this.currentTranscoder = transcoder;

    return createAudioResource(transcoder, {
      inputType: StreamType.OggOpus,
      metadata: track,
    });
  }

  // ── Команды управления ───────────────────────────────────────────────────

  /** Пропустить текущий трек. Возвращает false, если играть нечего. */
  skip(): boolean {
    if (!this.current && this.queue.length === 0) return false;
    this.pauseNext = this.isPaused;
    this.suppressLoop = true; // скип не должен повторять текущий трек
    // stop(true) → статус Idle → обработчик проиграет следующий.
    this.player.stop(true);
    return true;
  }

  /** Перемотать текущий трек на позицию (мс). false — если играть нечего. */
  seek(positionMs: number): boolean {
    if (!this.current) return false;
    const clamped = Math.max(0, Math.min(positionMs, Math.max(0, this.current.durationMs - 1000)));
    const oldTranscoder = this.currentTranscoder;
    this.seekOffsetMs = clamped;
    const resource = this.createResource(this.current, clamped);
    this.currentResource = resource;
    // play() заменяет ресурс на лету — старый отвязывается, Idle не стреляет.
    this.player.play(resource);
    try {
      oldTranscoder?.destroy();
    } catch {
      /* ignore */
    }
    this.clearIdleTimer();
    return true;
  }

  pause(): boolean {
    return this.player.pause(true);
  }

  resume(): boolean {
    return this.player.unpause();
  }

  /** Остановить воспроизведение и очистить очередь (бот остаётся до таймаута простоя). */
  stop(): void {
    this.queue = [];
    this.suppressLoop = true; // стоп не должен повторять трек
    this.pauseNext = false;
    this.player.stop(true);
  }

  /** Переключить повтор текущего трека. Возвращает новое состояние. */
  toggleLoop(): boolean {
    this.loopOne = !this.loopOne;
    return this.loopOne;
  }

  get isLooping(): boolean {
    return this.loopOne;
  }

  /** Записать трек в историю (лёгкой записью; без дублей подряд). */
  private recordHistory(track: Track): void {
    if (this.history[0]?.id === track.id) return;
    this.history.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      source: track.source,
      thumbUrl: track.thumbUrl,
      imageUrl: track.imageUrl,
      albumId: track.albumId,
    });
    if (this.history.length > 100) this.history.length = 100;
    this.onHistoryChange?.(this.history);
  }

  /** Недавно проигранные треки (свежие — первыми). */
  getHistory(): HistoryItem[] {
    return [...this.history];
  }

  /** Перемешать предстоящую часть очереди (текущий трек не трогаем). */
  shuffle(): number {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
    this.prefetchNext();
    return this.queue.length;
  }

  /** Немедленный выход из голосового канала и очистка. */
  leave(): void {
    this.destroy();
  }

  // ── Состояние ────────────────────────────────────────────────────────────

  getSnapshot(): QueueSnapshot {
    return { current: this.current, upcoming: [...this.queue], paused: this.isPaused };
  }

  getNowPlaying(): NowPlaying | null {
    if (!this.current) return null;
    return {
      track: this.current,
      playbackMs: this.seekOffsetMs + (this.currentResource?.playbackDuration ?? 0),
      paused: this.isPaused,
      buffering: this.isLoading,
    };
  }

  get isPaused(): boolean {
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused;
  }

  /**
   * Трек выбран, но звук ещё не пошёл: либо получаем стрим-URL (resolve у YouTube/Яндекс,
   * ресурс ещё не создан), либо FFmpeg только запускается (статус Buffering).
   */
  get isLoading(): boolean {
    if (!this.current) return false;
    if (!this.currentResource) return true;
    return this.player.state.status === AudioPlayerStatus.Buffering;
  }

  get isActive(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  // ── Реакция на пустоту канала (из voiceStateUpdate) ──────────────────────

  onChannelEmpty(): void {
    this.startIdleTimer();
  }

  onChannelActive(): void {
    if (this.isActive) this.clearIdleTimer();
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────

  private attachPlayerEvents(): void {
    // Диагностика: состояние плеера (buffering → playing → idle и т.п.).
    this.player.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        logger.info(`[player ${this.guildId}] ${oldState.status} → ${newState.status}`);
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.destroyed) return;
      // Текущий трек закончился (или его остановили) → следующий.
      void this.playNext();
    });
    this.player.on('error', (err) => {
      logger.error(
        `[${this.guildId}] Ошибка плеера на "${this.current?.title ?? '?'}": ${err.message}`,
      );
      // Не продвигаем очередь здесь: после ошибки плеер уйдёт в Idle и сам вызовет playNext.
    });
  }

  private attachConnectionEvents(connection: VoiceConnection): void {
    // Защита от дублирования слушателей на одном и том же соединении.
    const tagged = connection as VoiceConnection & { _dsbotAttached?: boolean };
    if (tagged._dsbotAttached) return;
    tagged._dsbotAttached = true;

    // Диагностика: переходы состояния голосового подключения.
    // Если без VPN/zapret виснет на Connecting и не доходит до Ready — блокируется
    // голосовой UDP (IP-discovery), значит стратегия zapret не покрывает этот трафик.
    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        logger.info(`[voice ${this.guildId}] ${oldState.status} → ${newState.status}`);
      }
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Краткий разрыв/переезд канала — даём voice восстановиться.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        logger.warn(`[${this.guildId}] Голос отвалился и не восстановился — отключаюсь.`);
        this.destroy();
      }
    });
    connection.on('error', (err) => {
      logger.error(`[${this.guildId}] Ошибка голосового подключения:`, err.message);
    });
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.info(`[${this.guildId}] Простой ${this.idleTimeoutMs} мс — выхожу из канала.`);
      this.destroy();
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdleTimer();
    this.queue = [];
    this.current = null;
    this.currentResource = null;
    // Явно убиваем FFmpeg-процесс (иначе остаётся осиротевшим до самозавершения).
    try {
      this.currentTranscoder?.destroy();
    } catch {
      /* ignore */
    }
    this.currentTranscoder = null;
    this.seekOffsetMs = 0;
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    // Снимаем слушатели — иначе их замыкания держат ссылку на this до GC.
    this.player.removeAllListeners();
    if (this.connection) {
      this.connection.removeAllListeners();
      try {
        this.connection.destroy();
      } catch {
        /* ignore */
      }
      this.connection = null;
    }
    this.onLeave(this.guildId);
  }
}
