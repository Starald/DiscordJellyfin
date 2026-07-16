import type { ItemsResponse, JellyfinItem, SystemInfo } from './types.js';

export interface JellyfinClientOptions {
  /** Базовый URL сервера, например https://jellyfin.example.com (без слеша на конце). */
  baseUrl: string;
  apiKey: string;
  /** Стабильный идентификатор устройства (для заголовка авторизации и Фазы 2). */
  deviceId?: string;
  /** Имя пользователя, чьи playlist'ы предпочитать (для эндпоинтов, требующих userId). */
  preferredUsername?: string;
}

interface JellyfinUser {
  Id: string;
  Name?: string;
}

type QueryValue = string | number | boolean | undefined;

const CLIENT_NAME = 'JellyfinDiscordBot';
const CLIENT_VERSION = '0.1.0';
const DEVICE_NAME = 'Discord';

/**
 * Тонкий типизированный клиент Jellyfin REST API.
 * Фаза 1: аутентификация по API-ключу (заголовок MediaBrowser Token).
 */
export class JellyfinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deviceId: string;
  private readonly preferredUsername?: string;
  private users: JellyfinUser[] | null = null;
  private preferredUserId: string | null = null;

  constructor(options: JellyfinClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.deviceId = options.deviceId ?? 'jellyfin-discord-bot';
    this.preferredUsername = options.preferredUsername;
  }

  /** Заголовок авторизации Jellyfin для JSON-эндпоинтов. */
  private authHeader(): string {
    return [
      `MediaBrowser Client="${CLIENT_NAME}"`,
      `Device="${DEVICE_NAME}"`,
      `DeviceId="${this.deviceId}"`,
      `Version="${CLIENT_VERSION}"`,
      `Token="${this.apiKey}"`,
    ].join(', ');
  }

  private async request<T>(path: string, params?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url, {
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Jellyfin вернул ${res.status} ${res.statusText} на ${path}` +
          (body ? `: ${body.slice(0, 300)}` : ''),
      );
    }

    return (await res.json()) as T;
  }

  /** Проверка связи + информация о сервере (имя, версия). */
  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('/System/Info');
  }

  /**
   * Поиск элементов библиотеки по подстроке.
   * @param includeItemTypes напр. ['MusicAlbum'] или ['MusicAlbum','MusicArtist'].
   */
  async searchItems(
    searchTerm: string,
    includeItemTypes: string[],
    limit = 25,
  ): Promise<JellyfinItem[]> {
    const res = await this.request<ItemsResponse>('/Items', {
      SearchTerm: searchTerm.trim() || undefined,
      IncludeItemTypes: includeItemTypes.join(','),
      Recursive: true,
      Limit: limit,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      EnableTotalRecordCount: false,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      Fields: 'MediaSources',
    });
    return res.Items ?? [];
  }

  /** Поиск альбомов. */
  async searchAlbums(searchTerm: string, limit = 25): Promise<JellyfinItem[]> {
    return this.searchItems(searchTerm, ['MusicAlbum'], limit);
  }

  /** Поиск с пагинацией: возвращает страницу + общее число записей (для «показать ещё»). */
  async searchItemsPaged(
    searchTerm: string,
    includeItemTypes: string[],
    startIndex = 0,
    limit = 50,
  ): Promise<{ items: JellyfinItem[]; total: number }> {
    const res = await this.request<ItemsResponse>('/Items', {
      SearchTerm: searchTerm.trim() || undefined,
      IncludeItemTypes: includeItemTypes.join(','),
      Recursive: true,
      StartIndex: startIndex,
      Limit: limit,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      EnableTotalRecordCount: true,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      Fields: 'MediaSources',
    });
    return { items: res.Items ?? [], total: res.TotalRecordCount ?? res.Items?.length ?? 0 };
  }

  /**
   * Треки альбома по порядку (диск → номер трека).
   * Recursive=true на случай вложенных папок (мультидиск).
   */
  async getAlbumTracks(albumId: string): Promise<JellyfinItem[]> {
    const res = await this.request<ItemsResponse>('/Items', {
      ParentId: albumId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
      Fields: 'MediaSources',
    });
    return res.Items ?? [];
  }

  /**
   * Получить один элемент по Id.
   * Используем /Items?Ids=, т.к. /Items/{id} на Jellyfin 10.11 отдаёт 400 без userId.
   */
  async getItem(itemId: string): Promise<JellyfinItem | null> {
    const res = await this.request<ItemsResponse>('/Items', {
      Ids: itemId,
      Recursive: true,
      Fields: 'MediaSources',
    });
    return res.Items?.[0] ?? null;
  }

  /** Все треки исполнителя, сгруппированные по альбомам и в порядке треков. */
  async getArtistTracks(artistId: string, limit = 500): Promise<JellyfinItem[]> {
    const res = await this.request<ItemsResponse>('/Items', {
      ArtistIds: artistId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
      Limit: limit,
      Fields: 'MediaSources',
    });
    return res.Items ?? [];
  }

  /** Список пользователей (кэшируется). Нужен для эндпоинтов, требующих userId. */
  private async loadUsers(): Promise<JellyfinUser[]> {
    if (this.users) return this.users;
    const list = await this.request<JellyfinUser[]>('/Users');
    this.users = Array.isArray(list) ? list : [];
    if (this.preferredUsername) {
      const match = this.users.find(
        (u) => u.Name?.toLowerCase() === this.preferredUsername!.toLowerCase(),
      );
      if (match) this.preferredUserId = match.Id;
    }
    return this.users;
  }

  /**
   * Треки плейлиста в порядке плейлиста.
   * /Playlists/{id}/Items требует userId (без него 400). Пробуем предпочитаемого
   * пользователя, затем остальных — на случай, если плейлист виден не каждому.
   */
  async getPlaylistTracks(playlistId: string): Promise<JellyfinItem[]> {
    const users = await this.loadUsers();
    const order = [
      ...(this.preferredUserId ? [this.preferredUserId] : []),
      ...users.map((u) => u.Id).filter((id) => id !== this.preferredUserId),
    ];
    for (const userId of order) {
      try {
        const res = await this.request<ItemsResponse>(`/Playlists/${playlistId}/Items`, {
          userId,
          Fields: 'MediaSources',
        });
        if (res.Items && res.Items.length > 0) return res.Items;
      } catch {
        /* пробуем следующего пользователя */
      }
    }
    return [];
  }

  /** Случайные треки из всей библиотеки. */
  async getRandomTracks(limit = 1): Promise<JellyfinItem[]> {
    const res = await this.request<ItemsResponse>('/Items', {
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Random',
      Limit: limit,
      Fields: 'MediaSources',
    });
    return res.Items ?? [];
  }

  /**
   * URL для прямого стрима оригинального файла (static=true → без транскода).
   * FFmpeg сам перекодирует в Opus, поэтому контейнер исходника не важен.
   * api_key кладём в query: FFmpeg получает обычный URL и наш заголовок не отправит.
   */
  getStreamUrl(itemId: string): string {
    const url = new URL(`${this.baseUrl}/Audio/${itemId}/stream`);
    url.searchParams.set('static', 'true');
    url.searchParams.set('mediaSourceId', itemId);
    url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  /**
   * URL обложки (Primary). Возвращает undefined, если itemId пустой.
   * withApiKey=true добавляет api_key в URL — для локального GUI (НЕ для Discord-embed,
   * чтобы не светить ключ в сообщениях).
   */
  getPrimaryImageUrl(
    itemId: string | undefined,
    tag?: string,
    maxHeight = 512,
    withApiKey = false,
  ): string | undefined {
    if (!itemId) return undefined;
    const url = new URL(`${this.baseUrl}/Items/${itemId}/Images/Primary`);
    url.searchParams.set('maxHeight', String(maxHeight));
    url.searchParams.set('quality', '90');
    if (tag) url.searchParams.set('tag', tag);
    if (withApiKey) url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  /** Скачать обложку с авторизацией (для серверного прокси /art веб-панели). */
  async fetchImage(itemId: string, tag?: string, maxHeight = 256): Promise<Response> {
    const url = this.getPrimaryImageUrl(itemId, tag, maxHeight, true);
    if (!url) throw new Error('Пустой itemId для обложки');
    return fetch(url, { signal: AbortSignal.timeout(8000) });
  }
}
