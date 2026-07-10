import { ProxyAgent, type Dispatcher } from 'undici';

const API = 'https://api.vk.com/method';
const V = '5.131';
// User-Agent клиента Kate Mobile (по умолчанию). Аудио-методы отдают ссылки только
// приложениям с доступом к аудио; UA должен совпадать с клиентом, которым добыт токен.
const KATE_UA =
  'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)';

export type VkType = 'track' | 'playlist';

export interface VkSearchItem {
  /** track: "{owner}_{id}"; playlist: "{owner}_{id}" или "{owner}_{id}_{accessKey}". */
  id: string;
  name: string;
  artist?: string;
  type: VkType;
  durationMs?: number;
  coverUrl?: string;
  /** Кол-во треков (для плейлиста) — чтобы решить: показать карточкой или сразу в очередь. */
  count?: number;
}

export interface VkTrack {
  /** "{owner}_{id}" (+ опц. "_{accessKey}"). */
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  coverUrl?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

function coverOf(a: Raw): string | undefined {
  const t = a?.album?.thumb;
  return t?.photo_300 ?? t?.photo_270 ?? t?.photo_135 ?? undefined;
}

function audioToTrack(a: Raw): VkTrack {
  return {
    id: `${a.owner_id}_${a.id}`,
    title: a.title ?? '',
    artist: a.artist ?? '',
    durationMs: (a.duration ?? 0) * 1000,
    coverUrl: coverOf(a),
  };
}

/** Тонкий клиент аудио ВКонтакте (через токен Kate Mobile). */
export class Vk {
  private readonly ua: string;
  private readonly dispatcher?: Dispatcher;

  constructor(
    private readonly token: string,
    ua?: string,
    proxy?: string,
  ) {
    this.ua = ua && ua.trim() ? ua.trim() : KATE_UA;
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  }

  get enabled(): boolean {
    return !!this.token;
  }

  private async call(method: string, params: Record<string, string | number>): Promise<Raw> {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
    usp.set('access_token', this.token);
    usp.set('v', V);
    const opts: RequestInit & { dispatcher?: Dispatcher } = {
      headers: { 'User-Agent': this.ua },
      dispatcher: this.dispatcher,
    };
    const res = await fetch(`${API}/${method}?${usp.toString()}`, opts);
    if (!res.ok) throw new Error(`VK HTTP ${res.status} на ${method}`);
    const json = (await res.json()) as Raw;
    if (json.error) {
      throw new Error(`VK API ${json.error.error_code}: ${json.error.error_msg}`);
    }
    return json.response;
  }

  // ── Поиск ──────────────────────────────────────────────────────────────────
  async search(text: string, type: VkType, limit = 30): Promise<VkSearchItem[]> {
    if (!text.trim()) return [];
    if (type === 'playlist') {
      const r = await this.call('audio.searchAlbums', { q: text, count: limit });
      return (r?.items ?? []).map((p: Raw) => ({
        id: `${p.owner_id}_${p.id}${p.access_key ? `_${p.access_key}` : ''}`,
        name: p.title ?? '',
        artist: p.owner_name ?? '',
        type: 'playlist' as const,
        coverUrl: p.thumb?.photo_300 ?? p.photo?.photo_300,
      }));
    }
    const r = await this.call('audio.search', {
      q: text,
      count: limit,
      auto_complete: 1,
      sort: 2,
    });
    return (r?.items ?? []).map((a: Raw) => ({
      id: `${a.owner_id}_${a.id}`,
      name: a.title ?? '',
      artist: a.artist ?? '',
      type: 'track' as const,
      durationMs: (a.duration ?? 0) * 1000,
      coverUrl: coverOf(a),
    }));
  }

  // ── Треки плейлиста (для раскрытия/импорта) ─────────────────────────────────
  /** playlistId формата "{owner}_{id}" или "{owner}_{id}_{accessKey}". */
  async getPlaylistTracks(playlistId: string): Promise<VkTrack[]> {
    const [owner, id, key] = playlistId.split('_');
    const params: Record<string, string | number> = {
      owner_id: owner ?? '',
      album_id: id ?? '',
      count: 300,
    };
    if (key) params.access_key = key;
    const r = await this.call('audio.get', params);
    return (r?.items ?? []).map(audioToTrack);
  }

  async getByIds(ids: string[]): Promise<VkTrack[]> {
    if (!ids.length) return [];
    const r = await this.call('audio.getById', { audios: ids.join(',') });
    return (Array.isArray(r) ? r : []).map(audioToTrack);
  }

  /** Инфо о плейлисте (название, обложка) — чтобы показать ссылку карточкой. */
  async getPlaylistInfo(playlistId: string): Promise<VkSearchItem | null> {
    const [owner, id, key] = playlistId.split('_');
    const params: Record<string, string | number> = {
      owner_id: owner ?? '',
      playlist_id: id ?? '',
    };
    if (key) params.access_key = key;
    const p = await this.call('audio.getPlaylistById', params);
    if (!p) return null;
    return {
      id: `${p.owner_id}_${p.id}${p.access_key ? `_${p.access_key}` : ''}`,
      name: p.title ?? 'Плейлист',
      artist: p.main_artists?.[0]?.name ?? p.owner_name ?? '',
      type: 'playlist',
      coverUrl: p.photo?.photo_300 ?? p.thumbs?.[0]?.photo_300,
      count: typeof p.count === 'number' ? p.count : undefined,
    };
  }

  // ── Стрим-URL (берётся из самого аудио-объекта, свежим на момент запуска) ────
  async getStreamUrl(id: string): Promise<string> {
    const r = await this.call('audio.getById', { audios: id });
    const a = Array.isArray(r) ? r[0] : null;
    const url: string = a?.url ?? '';
    if (!url) throw new Error('ВК не отдал ссылку на трек (недоступен в регионе/удалён?).');
    return url;
  }

  // ── Разбор ссылки vk.com ─────────────────────────────────────────────────────
  resolveLink(input: string): { type: VkType; id: string } | null {
    const url = input.trim();
    // Плейлист: music/album|playlist/{owner}_{id}_{key}  или  audio_playlist{owner}_{id}_{key}
    let m = url.match(
      /(?:music\/(?:album|playlist)\/|audio_playlist)(-?\d+)_(\d+)(?:[_/]([a-z0-9]+))?/i,
    );
    if (m) return { type: 'playlist', id: `${m[1]}_${m[2]}${m[3] ? `_${m[3]}` : ''}` };
    // Одиночный трек: audio{owner}_{id}_{key?}
    m = url.match(/audio(-?\d+)_(\d+)(?:_([a-z0-9]+))?/i);
    if (m) return { type: 'track', id: `${m[1]}_${m[2]}${m[3] ? `_${m[3]}` : ''}` };
    return null;
  }
}
