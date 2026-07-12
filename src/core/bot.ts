import { generateDependencyReport } from '@discordjs/voice';
import type { ServerResponse } from 'node:http';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { PlayerManager } from '../audio/manager.js';
import type { HistoryItem } from '../audio/player.js';
import { BrowserPlayer } from '../audio/browserPlayer.js';
import { resolveSelection, typeToItemTypes, type SearchType } from '../audio/resolve.js';
import { itemToTrack, type Track } from '../audio/track.js';
import { ticksToMs } from '../util/format.js';
import { YouTube, type YtVideo } from '../youtube/ytdlp.js';
import { YandexMusic, type YmSearchItem, type YmTrack, type YmType } from '../yandex/client.js';
import { Vk, type VkSearchItem, type VkTrack, type VkType } from '../vk/client.js';
import { loadConfig, type AppConfig } from '../config.js';
import { registerCommands } from '../discord/commandRegistry.js';
import { commandMap } from '../discord/commands/index.js';
import { handlePanelButton, handlePanelModal, handleHistorySelect } from '../discord/panel.js';
import { JellyfinClient } from '../jellyfin/client.js';
import type { JellyfinItem } from '../jellyfin/types.js';
import { loadState, saveState } from './persist.js';
import { logger } from '../logger.js';
import { setServices } from '../services.js';

export interface VoiceChannelInfo {
  id: string;
  name: string;
  members: number;
}

export interface SearchResultItem {
  id: string;
  name: string;
  artist?: string;
  year?: number;
  type: SearchType;
  imageUrl?: string;
  /** Id элемента для обложки — веб-панель грузит её через свой прокси /art/{artId}. */
  artId?: string;
}

export interface PlayResult {
  ok: boolean;
  message: string;
  enqueued?: number;
  startedNow?: boolean;
}

export interface BotState {
  ready: boolean;
  connected: boolean;
  channelId: string | null;
  /** Запомненный голосовой канал (для предвыбора в панели). */
  lastChannelId: string | null;
  paused: boolean;
  nowPlaying: {
    title: string;
    artist: string;
    album?: string;
    imageUrl?: string;
    artId?: string;
    /** Готовый URL обложки (для YouTube — /yt/thumb/{id}). */
    thumb?: string;
    durationMs: number;
    playbackMs: number;
    /** Идёт загрузка трека (звук ещё не пошёл) — для индикатора на прогресс-баре. */
    buffering: boolean;
    source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
  } | null;
  queue: {
    title: string;
    artist: string;
    durationMs: number;
    source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
    /** Статус предзагрузки головы очереди: loading/ready/error (для панели). */
    prefetch?: 'loading' | 'ready' | 'error';
  }[];
}

/** Состояние браузерного плеера — аналог BotState, но без голосового канала. */
export interface BrowserBotState {
  ready: boolean;
  paused: boolean;
  nowPlaying: {
    title: string;
    artist: string;
    album?: string;
    imageUrl?: string;
    artId?: string;
    thumb?: string;
    durationMs: number;
    playbackMs: number;
    buffering: boolean;
    source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
    /** Id текущего прогона стрима — клиент триггерит новый <audio src> при смене. */
    playId: string;
  } | null;
  queue: {
    title: string;
    artist: string;
    durationMs: number;
    source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
    prefetch?: 'loading' | 'ready' | 'error';
  }[];
}

export interface HistoryEntry {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
  artId?: string;
  thumb?: string;
}

const KIND_FROM_JELLYFIN: Record<string, SearchType> = {
  MusicAlbum: 'album',
  MusicArtist: 'artist',
  Playlist: 'playlist',
  Audio: 'track',
};

/**
 * Единое ядро бота: Discord-клиент, Jellyfin, очереди + API, которым пользуются
 * и slash-команды (через useServices), и графический интерфейс (Electron).
 */
export class Bot {
  readonly config: AppConfig;
  readonly jellyfin: JellyfinClient;
  readonly players: PlayerManager;
  readonly client: Client;
  readonly youtube: YouTube;
  readonly yandex: YandexMusic;
  readonly vk: Vk;
  /** Независимый от Discord плеер для режима «Проигрывание в браузере» (см. web/server.ts). */
  private readonly browserPlayer: BrowserPlayer;
  private started = false;
  private ready = false;
  /** Последний голосовой канал (запоминается между запусками). */
  private lastChannelId: string | null = null;

  constructor() {
    this.config = loadConfig();
    this.lastChannelId = loadState().lastChannelId ?? null;
    this.jellyfin = new JellyfinClient({
      baseUrl: this.config.jellyfin.url,
      apiKey: this.config.jellyfin.apiKey,
      preferredUsername: this.config.jellyfin.username,
    });
    this.players = new PlayerManager(this.config, {
      load: () => loadState().history ?? [],
      onChange: (items) => saveState({ history: items }),
    });
    this.youtube = new YouTube(
      this.config.youtube.cookiesPath,
      this.config.youtube.proxy,
      this.config.youtube.apiKey,
      this.config.youtube.cookiesFromBrowser,
    );
    this.yandex = new YandexMusic(this.config.yandex.token ?? '', this.config.yandex.proxy);
    this.vk = new Vk(this.config.vk.token ?? '', this.config.vk.userAgent, this.config.vk.proxy);
    this.browserPlayer = new BrowserPlayer({ onTrackStart: (track) => this.recordBrowserHistory(track) });
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    setServices({
      config: this.config,
      jellyfin: this.jellyfin,
      players: this.players,
      bot: this,
    });
  }

  // ── Жизненный цикл ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    logger.info('Отчёт зависимостей @discordjs/voice:\n' + generateDependencyReport());
    this.wireEvents();
    await this.client.login(this.config.discord.token);
  }

  async shutdown(): Promise<void> {
    this.players.get(this.guildId)?.leave();
    this.browserPlayer.destroy();
    await this.client.destroy();
    this.started = false;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  // ── GUI API ────────────────────────────────────────────────────────────────

  get guildId(): string {
    return this.config.discord.guildId;
  }

  /** Голосовые каналы гильдии (с числом живых слушателей). */
  listVoiceChannels(): VoiceChannelInfo[] {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return [];
    return [...guild.channels.cache.values()]
      .filter((c) => c.isVoiceBased())
      .map((c) => ({
        id: c.id,
        name: c.name,
        members: c.members.filter((m) => !m.user.bot).size,
      }));
  }

  private toSearchResult(it: JellyfinItem, fallbackType: SearchType): SearchResultItem {
    const artist =
      (it.Artists && it.Artists.length > 0 ? it.Artists.join(', ') : undefined) ?? it.AlbumArtist;
    return {
      id: it.Id,
      name: it.Name,
      artist,
      year: it.ProductionYear,
      type: KIND_FROM_JELLYFIN[it.Type ?? ''] ?? fallbackType,
      // artId задаём только если у элемента реально есть обложка (иначе /art = 404 + спам в консоли).
      artId: (it.AlbumPrimaryImageTag ?? it.ImageTags?.Primary) ? (it.AlbumId ?? it.Id) : undefined,
      imageUrl: this.jellyfin.getPrimaryImageUrl(
        it.AlbumId ?? it.Id,
        it.AlbumPrimaryImageTag ?? it.ImageTags?.Primary,
        256,
        true,
      ),
    };
  }

  /** Поиск по Jellyfin для интерфейса (album/artist/playlist/track). */
  async search(term: string, type: SearchType): Promise<SearchResultItem[]> {
    const items = await this.jellyfin.searchItems(term, typeToItemTypes(type), 25);
    return items.map((it) => this.toSearchResult(it, type));
  }

  /** Поиск с пагинацией для веб-панели (просмотр всей библиотеки). */
  async searchPage(
    term: string,
    type: SearchType,
    startIndex = 0,
    limit = 50,
  ): Promise<{ items: SearchResultItem[]; total: number }> {
    const { items, total } = await this.jellyfin.searchItemsPaged(
      term,
      typeToItemTypes(type),
      startIndex,
      limit,
    );
    return { items: items.map((it) => this.toSearchResult(it, type)), total };
  }

  /** Треки объекта (альбом/исполнитель/плейлист) для раскрытия в интерфейсе. */
  async getTracksFor(
    id: string,
    type: SearchType,
  ): Promise<{ id: string; title: string; artist: string; durationMs: number; index?: number }[]> {
    let items: JellyfinItem[] = [];
    if (type === 'album') items = await this.jellyfin.getAlbumTracks(id);
    else if (type === 'artist') items = await this.jellyfin.getArtistTracks(id);
    else if (type === 'playlist') items = await this.jellyfin.getPlaylistTracks(id);

    return items.map((it) => ({
      id: it.Id,
      title: it.Name,
      artist:
        (it.Artists && it.Artists.length > 0 ? it.Artists.join(', ') : undefined) ??
        it.AlbumArtist ??
        '',
      durationMs: ticksToMs(it.RunTimeTicks),
      index: it.IndexNumber,
    }));
  }

  /** Запустить воспроизведение из интерфейса: подключиться к каналу и поставить в очередь. */
  async play(opts: {
    channelId: string;
    query: string;
    type: SearchType;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const resolved = await resolveSelection(this.jellyfin, opts.query, opts.type);
    if (!resolved || resolved.tracks.length === 0) {
      return { ok: false, message: 'По запросу ничего не нашёл.' };
    }
    const tracks = resolved.tracks.map((it) => itemToTrack(it, this.jellyfin));
    return this.connectAndEnqueue(opts.channelId, tracks, opts.position ?? 'end', resolved.item.Name);
  }

  /** Добавить в очередь случайный трек из библиотеки. */
  async playRandom(opts: { channelId: string; position?: 'end' | 'next' }): Promise<PlayResult> {
    const items = await this.jellyfin.getRandomTracks(1);
    if (items.length === 0) return { ok: false, message: 'Не удалось найти случайный трек.' };
    const t = items[0]!;
    const artist = t.Artists?.[0] ?? t.AlbumArtist;
    const label = artist ? `${artist} — ${t.Name}` : t.Name;
    const tracks = items.map((it) => itemToTrack(it, this.jellyfin));
    return this.connectAndEnqueue(opts.channelId, tracks, opts.position ?? 'end', label);
  }

  // ── YouTube ─────────────────────────────────────────────────────────────────

  /** Поиск по YouTube: сперва быстрый Data API, при недоступности — yt-dlp. */
  async ytSearch(query: string): Promise<YtVideo[]> {
    const viaApi = await this.youtube.searchViaApi(query, 15);
    if (viaApi !== null) return viaApi;
    return this.youtube.resolve(query, 20);
  }

  /** Добавить YouTube-видео в очередь. */
  async playYouTube(opts: {
    channelId: string;
    videoId: string;
    title?: string;
    channel?: string;
    durationMs?: number;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const id = opts.videoId;
    const track: Track = {
      id: `yt-${id}`,
      title: opts.title ?? id,
      artist: opts.channel ?? 'YouTube',
      durationMs: opts.durationMs ?? 0,
      streamUrl: '',
      thumbUrl: `/yt/thumb/${id}`,
      resolve: () => this.youtube.getAudioUrl(id),
      source: 'youtube',
      // FFmpeg должен качать поток через ТОТ ЖЕ прокси, что и yt-dlp: googlevideo-ссылка
      // подписана под exit-IP прокси, иначе с другого IP вернётся 403 (даже под VPN).
      proxy: this.config.youtube.proxy,
    };
    return this.connectAndEnqueue(opts.channelId, [track], opts.position ?? 'end', track.title);
  }

  /** Разобрать ссылку YouTube: плейлист (карточкой) или одиночное видео. */
  ytResolveLink(url: string) {
    return this.youtube.resolveUrl(url);
  }

  /** Видео плейлиста YouTube — для раскрытия карточки. */
  async ytPlaylistVideos(url: string): Promise<YtVideo[]> {
    return (await this.youtube.getPlaylist(url)).videos;
  }

  /** Добавить весь плейлист YouTube в очередь. */
  async playYouTubePlaylist(opts: {
    channelId: string;
    url: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const videos = await this.ytPlaylistVideos(opts.url);
    if (videos.length === 0) return { ok: false, message: 'В плейлисте нет видео.' };
    const tracks: Track[] = videos.map((v) => ({
      id: `yt-${v.id}`,
      title: v.title,
      artist: v.channel ?? 'YouTube',
      durationMs: v.durationMs,
      streamUrl: '',
      thumbUrl: `/yt/thumb/${v.id}`,
      resolve: () => this.youtube.getAudioUrl(v.id),
      source: 'youtube',
      proxy: this.config.youtube.proxy, // см. playYouTube: стрим через тот же прокси, что и резолв
    }));
    return this.connectAndEnqueue(
      opts.channelId,
      tracks,
      opts.position ?? 'end',
      `плейлист (${tracks.length})`,
    );
  }

  // ── Яндекс.Музыка ─────────────────────────────────────────────────────────────

  async yandexSearch(query: string, type: YmType): Promise<YmSearchItem[]> {
    if (!this.yandex.enabled) return [];
    return this.yandex.search(query, type, 20);
  }

  /** Треки объекта Яндекса (album/artist/playlist) — для раскрытия в панели. */
  async yandexTracksFor(id: string, type: YmType): Promise<YmTrack[]> {
    if (type === 'album') return this.yandex.getAlbumTracks(id);
    if (type === 'artist') return this.yandex.getArtistTracks(id);
    if (type === 'playlist') return this.yandex.getPlaylistTracks(id);
    return [];
  }

  /** Разобрать ссылку Яндекс.Музыки → {type, id}. */
  resolveYandexLink(url: string): { type: YmType; id: string } | null {
    return this.yandex.resolveLink(url);
  }

  /** Разобрать ссылку Яндекса → готовый элемент с числом треков (для решения карточка/очередь). */
  async yandexResolveToItem(url: string): Promise<YmSearchItem | null> {
    if (!this.yandex.enabled) return null;
    return this.yandex.resolveLinkItem(url);
  }

  /** Добавить в очередь из Яндекс.Музыки (трек/альбом/исполнитель/плейлист). */
  async playYandex(opts: {
    channelId: string;
    id: string;
    type: YmType;
    title?: string;
    artist?: string;
    durationMs?: number;
    coverUrl?: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    if (!this.yandex.enabled) {
      return { ok: false, message: 'Яндекс.Музыка не настроена (нет токена).' };
    }

    let ymTracks: YmTrack[];
    let label: string;
    if (opts.type === 'track') {
      let t: YmTrack = {
        id: opts.id,
        title: opts.title ?? '',
        artist: opts.artist ?? '',
        durationMs: opts.durationMs ?? 0,
        coverUrl: opts.coverUrl,
      };
      if (!t.title) {
        const fetched = await this.yandex.getTrack(opts.id);
        if (fetched) t = fetched;
      }
      ymTracks = [t];
      label = t.title || 'трек';
    } else if (opts.type === 'album') {
      ymTracks = await this.yandex.getAlbumTracks(opts.id);
      label = opts.title ?? 'альбом';
    } else if (opts.type === 'artist') {
      ymTracks = await this.yandex.getArtistTracks(opts.id);
      label = opts.title ?? 'исполнитель';
    } else {
      ymTracks = await this.yandex.getPlaylistTracks(opts.id);
      label = opts.title ?? 'плейлист';
    }

    if (ymTracks.length === 0) {
      return { ok: false, message: 'Не нашёл треков (для стрима нужна подписка Плюс?).' };
    }

    const tracks: Track[] = ymTracks.map((t) => ({
      id: `ym-${t.id}`,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      streamUrl: '',
      thumbUrl: t.coverUrl,
      resolve: () => this.yandex.getStreamUrl(t.id),
      source: 'yandex',
      proxy: this.config.yandex.proxy,
    }));
    return this.connectAndEnqueue(opts.channelId, tracks, opts.position ?? 'end', label);
  }

  // ── ВКонтакте ─────────────────────────────────────────────────────────────────

  async vkSearch(query: string, type: VkType): Promise<VkSearchItem[]> {
    if (!this.vk.enabled) return [];
    return this.vk.search(query, type, 30);
  }

  /** Треки плейлиста ВК — для раскрытия в панели. */
  async vkTracksFor(id: string, type: VkType): Promise<VkTrack[]> {
    if (type === 'playlist') return this.vk.getPlaylistTracks(id);
    return [];
  }

  /**
   * Разобрать ссылку vk.com → готовый элемент для показа в результатах (карточкой),
   * а не для немедленного добавления. Для плейлиста тянем название/обложку, для трека — инфо.
   */
  async vkResolveToItem(url: string): Promise<VkSearchItem | null> {
    if (!this.vk.enabled) return null;
    const link = this.vk.resolveLink(url);
    if (!link) return null;
    if (link.type === 'playlist') {
      const info = await this.vk.getPlaylistInfo(link.id).catch(() => null);
      return info ?? { id: link.id, name: 'Плейлист ВК', type: 'playlist' };
    }
    const t = (await this.vk.getByIds([link.id]).catch(() => []))[0];
    return t
      ? {
          id: t.id,
          name: t.title,
          artist: t.artist,
          type: 'track',
          durationMs: t.durationMs,
          coverUrl: t.coverUrl,
        }
      : { id: link.id, name: 'Трек ВК', type: 'track' };
  }

  /** Добавить в очередь из ВКонтакте (трек/плейлист). */
  async playVk(opts: {
    channelId: string;
    id: string;
    type: VkType;
    title?: string;
    artist?: string;
    durationMs?: number;
    coverUrl?: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    if (!this.vk.enabled) {
      return { ok: false, message: 'ВКонтакте не настроен (нет токена).' };
    }

    let vkTracks: VkTrack[];
    let label: string;
    if (opts.type === 'track') {
      let t: VkTrack = {
        id: opts.id,
        title: opts.title ?? '',
        artist: opts.artist ?? '',
        durationMs: opts.durationMs ?? 0,
        coverUrl: opts.coverUrl,
      };
      if (!t.title) {
        const fetched = (await this.vk.getByIds([opts.id]))[0];
        if (fetched) t = fetched;
      }
      vkTracks = [t];
      label = t.title || 'трек';
    } else {
      vkTracks = await this.vk.getPlaylistTracks(opts.id);
      label = opts.title ?? 'плейлист';
    }

    if (vkTracks.length === 0) {
      return { ok: false, message: 'Не нашёл треков ВКонтакте (недоступны в регионе?).' };
    }

    const tracks: Track[] = vkTracks.map((t) => ({
      id: `vk-${t.id}`,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      streamUrl: '',
      thumbUrl: t.coverUrl,
      resolve: () => this.vk.getStreamUrl(t.id),
      source: 'vk',
      proxy: this.config.vk.proxy,
    }));
    return this.connectAndEnqueue(opts.channelId, tracks, opts.position ?? 'end', label);
  }

  /** Общий путь: подключиться к каналу, поставить треки в очередь, запустить. */
  private async connectAndEnqueue(
    channelId: string,
    tracks: Track[],
    position: 'end' | 'next',
    label: string,
  ): Promise<PlayResult> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return { ok: false, message: 'Гильдия не найдена. Бот точно на сервере?' };

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) {
      return { ok: false, message: 'Выбранный канал не найден или не голосовой.' };
    }
    if (tracks.length === 0) return { ok: false, message: 'Нечего добавить в очередь.' };

    const player = this.players.getOrCreate(this.guildId);
    player.connect(channel as VoiceBasedChannel);
    try {
      await player.ensureReady();
    } catch {
      player.leave();
      return { ok: false, message: 'Не удалось подключиться к голосовому каналу (таймаут).' };
    }

    // Запоминаем канал между запусками.
    if (this.lastChannelId !== channelId) {
      this.lastChannelId = channelId;
      saveState({ lastChannelId: channelId });
    }

    const startedNow = !player.getNowPlaying();
    player.enqueue(tracks, position);
    await player.start();

    const where = position === 'next' ? 'Добавил следующим' : 'Добавил в очередь';
    return {
      ok: true,
      message: `${startedNow ? 'Играю' : where}: ${label}`,
      enqueued: tracks.length,
      startedNow,
    };
  }

  togglePause(): boolean {
    const player = this.players.get(this.guildId);
    if (!player || !player.getNowPlaying()) return false;
    if (player.isPaused) player.resume();
    else player.pause();
    return player.isPaused;
  }

  skip(): boolean {
    return this.players.get(this.guildId)?.skip() ?? false;
  }

  /** Перемотать текущий трек на позицию (мс). */
  seek(positionMs: number): boolean {
    return this.players.get(this.guildId)?.seek(positionMs) ?? false;
  }

  stop(): void {
    this.players.get(this.guildId)?.stop();
  }

  shuffle(): number {
    return this.players.get(this.guildId)?.shuffle() ?? 0;
  }

  /** Удалить трек из очереди по индексу. */
  removeFromQueue(index: number): boolean {
    return !!this.players.get(this.guildId)?.removeAt(index);
  }

  /** Переместить трек в очереди (from → to). */
  moveInQueue(from: number, to: number): boolean {
    return this.players.get(this.guildId)?.moveTrack(from, to) ?? false;
  }

  leave(): void {
    this.players.get(this.guildId)?.leave();
  }

  /** Сразу подключиться (или переехать) в голосовой канал — без добавления в очередь. */
  async joinChannel(channelId: string): Promise<PlayResult> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return { ok: false, message: 'Гильдия не найдена. Бот точно на сервере?' };

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) {
      return { ok: false, message: 'Выбранный канал не найден или не голосовой.' };
    }

    const player = this.players.getOrCreate(this.guildId);
    player.connect(channel as VoiceBasedChannel);
    try {
      await player.ensureReady();
    } catch {
      return { ok: false, message: 'Не удалось подключиться к голосовому каналу (таймаут).' };
    }

    // Запоминаем выбранный канал между запусками (как и при воспроизведении).
    if (this.lastChannelId !== channelId) {
      this.lastChannelId = channelId;
      saveState({ lastChannelId: channelId });
    }
    return { ok: true, message: `Зашёл в канал: ${channel.name}` };
  }

  getState(): BotState {
    const player = this.players.get(this.guildId);
    const np = player?.getNowPlaying() ?? null;
    const snapshot = player?.getSnapshot();
    return {
      ready: this.ready,
      connected: !!player?.channelId,
      channelId: player?.channelId ?? null,
      lastChannelId: this.lastChannelId,
      paused: np?.paused ?? false,
      nowPlaying: np
        ? {
            title: np.track.title,
            artist: np.track.artist,
            album: np.track.album,
            imageUrl: np.track.imageUrl,
            // /art — это ПРОКСИ ТОЛЬКО к Jellyfin: artId даём лишь для Jellyfin-трека (обложка
            // отдаётся через /art). У VK/Яндекс/YouTube — прямой thumb (или «нет фото», если пусто).
            artId: np.track.source === 'jellyfin' ? (np.track.albumId ?? np.track.id) : undefined,
            thumb: np.track.thumbUrl,
            durationMs: np.track.durationMs,
            playbackMs: np.playbackMs,
            buffering: np.buffering,
            source: np.track.source,
          }
        : null,
      queue: (snapshot?.upcoming ?? []).map((t) => ({
        title: t.title,
        artist: t.artist,
        durationMs: t.durationMs,
        source: t.source,
        prefetch: t.prefetchState,
      })),
    };
  }

  /** Текущая история (из сохранённого состояния — доступна и до создания плеера). */
  getRecentHistory(): HistoryItem[] {
    return loadState().history ?? [];
  }

  /** Недавно проигранные треки (для веб-панели), уникальные по id. */
  getHistoryList(): HistoryEntry[] {
    const hist = this.getRecentHistory();
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const t of hist) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({
        id: t.id,
        title: t.title,
        artist: t.artist,
        durationMs: t.durationMs,
        source: t.source,
        // artId только для Jellyfin (/art — прокси к Jellyfin). Иначе — прямой thumb / «нет фото».
        artId: t.source === 'jellyfin' ? (t.albumId ?? t.id) : undefined,
        thumb: t.thumbUrl,
      });
      if (out.length >= 100) break;
    }
    return out;
  }

  /** Повторно добавить трек из истории в очередь (пересобираем играбельный Track). */
  async playFromHistory(
    channelId: string,
    id: string,
    position: 'end' | 'next',
  ): Promise<PlayResult> {
    const item = this.getRecentHistory().find((t) => t.id === id);
    if (!item) return { ok: false, message: 'Трек не найден в истории.' };
    const track = this.historyItemToTrack(item);
    return this.connectAndEnqueue(channelId, [track], position, track.title);
  }

  /** Лёгкая запись истории → играбельный Track (resolve/stream-URL восстанавливаем по id+source). */
  private historyItemToTrack(item: HistoryItem): Track {
    const base: Track = {
      id: item.id,
      title: item.title,
      artist: item.artist,
      durationMs: item.durationMs,
      streamUrl: '',
      thumbUrl: item.thumbUrl,
      imageUrl: item.imageUrl,
      albumId: item.albumId,
      source: item.source,
    };
    if (item.source === 'youtube') {
      const vid = item.id.replace(/^yt-/, '');
      return {
        ...base,
        resolve: () => this.youtube.getAudioUrl(vid),
        proxy: this.config.youtube.proxy, // стрим через тот же прокси, что и резолв (см. playYouTube)
      };
    }
    if (item.source === 'vk') {
      const vkId = item.id.replace(/^vk-/, '');
      return { ...base, resolve: () => this.vk.getStreamUrl(vkId), proxy: this.config.vk.proxy };
    }
    if (item.source === 'yandex') {
      const ymId = item.id.replace(/^ym-/, '');
      return { ...base, resolve: () => this.yandex.getStreamUrl(ymId), proxy: this.config.yandex.proxy };
    }
    // Jellyfin: прямой стрим по id (свежий URL с api_key — на диск он не сохранялся).
    return { ...base, streamUrl: this.jellyfin.getStreamUrl(item.id) };
  }

  /**
   * Записать трек в ОБЩУЮ историю (тот же state.json, что читает getRecentHistory() и что
   * пишет GuildMusicPlayer.recordHistory() из Discord-режима) — история одна на оба режима,
   * не две разные. В отличие от Discord-версии, каждый раз читаем с диска заново, а не из
   * своего in-memory кэша: у browserPlayer его и нет, так что нечему разъезжаться с тем,
   * что параллельно пишет Discord-плеер (или наоборот) при переключении между режимами.
   */
  private recordBrowserHistory(track: Track): void {
    const hist = loadState().history ?? [];
    if (hist[0]?.id === track.id) return;
    hist.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      source: track.source,
      thumbUrl: track.thumbUrl,
      imageUrl: track.imageUrl,
      albumId: track.albumId,
    });
    if (hist.length > 100) hist.length = 100;
    saveState({ history: hist });
  }

  // ── Режим «Проигрывание в браузере» ──────────────────────────────────────────
  // Та же логика построения Track, что и в play*/выше, но вместо connectAndEnqueue (Discord
  // voice) — независимая очередь browserPlayer, стримящая MP3 по HTTP (см. web/server.ts).
  // Поиск/resolve/tracks-эндпоинты общие для обоих режимов — им дублирование не нужно.

  async browserPlay(opts: {
    query: string;
    type: SearchType;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const resolved = await resolveSelection(this.jellyfin, opts.query, opts.type);
    if (!resolved || resolved.tracks.length === 0) {
      return { ok: false, message: 'По запросу ничего не нашёл.' };
    }
    const tracks = resolved.tracks.map((it) => itemToTrack(it, this.jellyfin));
    this.browserPlayer.enqueue(tracks, opts.position ?? 'end');
    return {
      ok: true,
      message: `В очередь браузера: ${resolved.item.Name}`,
      enqueued: tracks.length,
    };
  }

  async browserPlayRandom(opts: { position?: 'end' | 'next' }): Promise<PlayResult> {
    const items = await this.jellyfin.getRandomTracks(1);
    if (items.length === 0) return { ok: false, message: 'Не удалось найти случайный трек.' };
    const tracks = items.map((it) => itemToTrack(it, this.jellyfin));
    this.browserPlayer.enqueue(tracks, opts.position ?? 'end');
    return { ok: true, message: 'Случайный трек — в очередь браузера.', enqueued: tracks.length };
  }

  async browserPlayYouTube(opts: {
    videoId: string;
    title?: string;
    channel?: string;
    durationMs?: number;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const id = opts.videoId;
    const track: Track = {
      id: `yt-${id}`,
      title: opts.title ?? id,
      artist: opts.channel ?? 'YouTube',
      durationMs: opts.durationMs ?? 0,
      streamUrl: '',
      thumbUrl: `/yt/thumb/${id}`,
      resolve: () => this.youtube.getAudioUrl(id),
      source: 'youtube',
      proxy: this.config.youtube.proxy,
    };
    this.browserPlayer.enqueue([track], opts.position ?? 'end');
    return { ok: true, message: `В очередь браузера: ${track.title}`, enqueued: 1 };
  }

  async browserPlayYouTubePlaylist(opts: {
    url: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    const videos = await this.ytPlaylistVideos(opts.url);
    if (videos.length === 0) return { ok: false, message: 'В плейлисте нет видео.' };
    const tracks: Track[] = videos.map((v) => ({
      id: `yt-${v.id}`,
      title: v.title,
      artist: v.channel ?? 'YouTube',
      durationMs: v.durationMs,
      streamUrl: '',
      thumbUrl: `/yt/thumb/${v.id}`,
      resolve: () => this.youtube.getAudioUrl(v.id),
      source: 'youtube',
      proxy: this.config.youtube.proxy,
    }));
    this.browserPlayer.enqueue(tracks, opts.position ?? 'end');
    return {
      ok: true,
      message: `плейлист (${tracks.length}) — в очередь браузера`,
      enqueued: tracks.length,
    };
  }

  async browserPlayYandex(opts: {
    id: string;
    type: YmType;
    title?: string;
    artist?: string;
    durationMs?: number;
    coverUrl?: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    if (!this.yandex.enabled) {
      return { ok: false, message: 'Яндекс.Музыка не настроена (нет токена).' };
    }
    let ymTracks: YmTrack[];
    let label: string;
    if (opts.type === 'track') {
      let t: YmTrack = {
        id: opts.id,
        title: opts.title ?? '',
        artist: opts.artist ?? '',
        durationMs: opts.durationMs ?? 0,
        coverUrl: opts.coverUrl,
      };
      if (!t.title) {
        const fetched = await this.yandex.getTrack(opts.id);
        if (fetched) t = fetched;
      }
      ymTracks = [t];
      label = t.title || 'трек';
    } else if (opts.type === 'album') {
      ymTracks = await this.yandex.getAlbumTracks(opts.id);
      label = opts.title ?? 'альбом';
    } else if (opts.type === 'artist') {
      ymTracks = await this.yandex.getArtistTracks(opts.id);
      label = opts.title ?? 'исполнитель';
    } else {
      ymTracks = await this.yandex.getPlaylistTracks(opts.id);
      label = opts.title ?? 'плейлист';
    }
    if (ymTracks.length === 0) {
      return { ok: false, message: 'Не нашёл треков (для стрима нужна подписка Плюс?).' };
    }
    const tracks: Track[] = ymTracks.map((t) => ({
      id: `ym-${t.id}`,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      streamUrl: '',
      thumbUrl: t.coverUrl,
      resolve: () => this.yandex.getStreamUrl(t.id),
      source: 'yandex',
      proxy: this.config.yandex.proxy,
    }));
    this.browserPlayer.enqueue(tracks, opts.position ?? 'end');
    return { ok: true, message: `${label} — в очередь браузера`, enqueued: tracks.length };
  }

  async browserPlayVk(opts: {
    id: string;
    type: VkType;
    title?: string;
    artist?: string;
    durationMs?: number;
    coverUrl?: string;
    position?: 'end' | 'next';
  }): Promise<PlayResult> {
    if (!this.vk.enabled) {
      return { ok: false, message: 'ВКонтакте не настроен (нет токена).' };
    }
    let vkTracks: VkTrack[];
    let label: string;
    if (opts.type === 'track') {
      let t: VkTrack = {
        id: opts.id,
        title: opts.title ?? '',
        artist: opts.artist ?? '',
        durationMs: opts.durationMs ?? 0,
        coverUrl: opts.coverUrl,
      };
      if (!t.title) {
        const fetched = (await this.vk.getByIds([opts.id]))[0];
        if (fetched) t = fetched;
      }
      vkTracks = [t];
      label = t.title || 'трек';
    } else {
      vkTracks = await this.vk.getPlaylistTracks(opts.id);
      label = opts.title ?? 'плейлист';
    }
    if (vkTracks.length === 0) {
      return { ok: false, message: 'Не нашёл треков ВКонтакте (недоступны в регионе?).' };
    }
    const tracks: Track[] = vkTracks.map((t) => ({
      id: `vk-${t.id}`,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      streamUrl: '',
      thumbUrl: t.coverUrl,
      resolve: () => this.vk.getStreamUrl(t.id),
      source: 'vk',
      proxy: this.config.vk.proxy,
    }));
    this.browserPlayer.enqueue(tracks, opts.position ?? 'end');
    return { ok: true, message: `${label} — в очередь браузера`, enqueued: tracks.length };
  }

  /** Повторно добавить трек из истории в очередь браузера. */
  async browserPlayFromHistory(id: string, position: 'end' | 'next' = 'end'): Promise<PlayResult> {
    const item = this.getRecentHistory().find((t) => t.id === id);
    if (!item) return { ok: false, message: 'Трек не найден в истории.' };
    const track = this.historyItemToTrack(item);
    this.browserPlayer.enqueue([track], position);
    return { ok: true, message: `${track.title} — в очередь браузера`, enqueued: 1 };
  }

  // ── Управление браузерным плеером ────────────────────────────────────────────

  /** Переключить флажок «воспроизводить музыку». */
  browserTogglePlaying(): boolean {
    return this.browserPlayer.togglePlaying();
  }

  browserSkip(): boolean {
    return this.browserPlayer.skip();
  }

  browserSeek(positionMs: number): boolean {
    return this.browserPlayer.seek(positionMs);
  }

  browserStop(): void {
    this.browserPlayer.stop();
  }

  browserShuffle(): number {
    return this.browserPlayer.shuffle();
  }

  browserRemoveFromQueue(index: number): boolean {
    return !!this.browserPlayer.removeAt(index);
  }

  browserMoveInQueue(from: number, to: number): boolean {
    return this.browserPlayer.moveTrack(from, to);
  }

  browserGetState(): BrowserBotState {
    const np = this.browserPlayer.getNowPlaying();
    const snapshot = this.browserPlayer.getSnapshot();
    return {
      ready: true,
      paused: np?.paused ?? this.browserPlayer.isPaused,
      nowPlaying: np
        ? {
            title: np.track.title,
            artist: np.track.artist,
            album: np.track.album,
            imageUrl: np.track.imageUrl,
            artId: np.track.source === 'jellyfin' ? (np.track.albumId ?? np.track.id) : undefined,
            thumb: np.track.thumbUrl,
            durationMs: np.track.durationMs,
            playbackMs: np.playbackMs,
            buffering: np.buffering,
            source: np.track.source,
            playId: np.playId,
          }
        : null,
      queue: snapshot.upcoming.map((t) => ({
        title: t.title,
        artist: t.artist,
        durationMs: t.durationMs,
        source: t.source,
        prefetch: t.prefetchState,
      })),
    };
  }

  /** Подписать HTTP-ответ на живой аудио-поток текущего прогона (см. GET /api/browser/stream). */
  browserAttachStream(res: ServerResponse, playId: string): boolean {
    return this.browserPlayer.attachListener(res, playId);
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────────

  private wireEvents(): void {
    this.client.once(Events.ClientReady, async (readyClient) => {
      this.ready = true;
      logger.info(`Вошёл как ${readyClient.user.tag} (id: ${readyClient.user.id})`);
      try {
        await registerCommands(this.config);
      } catch (err) {
        logger.error('Не удалось зарегистрировать slash-команды:', err);
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        const command = commandMap.get(interaction.commandName);
        if (!command) return;
        try {
          await command.execute(interaction);
        } catch (err) {
          logger.error(`Ошибка в команде /${interaction.commandName}:`, err);
          const content = 'Произошла ошибка при выполнении команды.';
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        }
        return;
      }

      if (interaction.isAutocomplete()) {
        const command = commandMap.get(interaction.commandName);
        if (!command?.autocomplete) return;
        try {
          await command.autocomplete(interaction);
        } catch (err) {
          logger.error(`Ошибка автодополнения /${interaction.commandName}:`, err);
        }
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('panel:')) {
        try {
          await handlePanelButton(interaction);
        } catch (err) {
          logger.error('Ошибка кнопки панели:', err);
        }
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === 'panel:addModal') {
        try {
          await handlePanelModal(interaction);
        } catch (err) {
          logger.error('Ошибка модалки панели:', err);
        }
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('hist:')) {
        try {
          await handleHistorySelect(interaction);
        } catch (err) {
          logger.error('Ошибка выбора истории:', err);
        }
      }
    });

    this.client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
      const player = this.players.get(oldState.guild.id);
      if (!player) return;
      const channelId = player.channelId;
      if (!channelId) return;
      if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

      const channel = oldState.guild.channels.cache.get(channelId);
      if (!channel || !channel.isVoiceBased()) return;

      const humans = channel.members.filter((m) => !m.user.bot).size;
      if (humans === 0) player.onChannelEmpty();
      else player.onChannelActive();
    });
  }
}
