import crypto from 'node:crypto';
import { ProxyAgent, type Dispatcher } from 'undici';

const API = 'https://api.music.yandex.net';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

export type YmType = 'track' | 'album' | 'artist' | 'playlist';

export interface YmSearchItem {
  /** track id / album id / artist id / "uid:kind" для плейлиста. */
  id: string;
  name: string;
  artist?: string;
  year?: number;
  type: YmType;
  coverUrl?: string;
  durationMs?: number;
  /** Кол-во треков в коллекции — чтобы решить: показать карточкой или сразу в очередь. */
  count?: number;
}

export interface YmTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  coverUrl?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

function cover(uri: string | undefined, size = '400x400'): string | undefined {
  if (!uri) return undefined;
  return 'https://' + uri.replace('%%', size);
}

function artistsOf(t: Raw): string {
  const a = (t?.artists ?? []).map((x: Raw) => x?.name).filter(Boolean);
  return a.length ? a.join(', ') : '';
}

/** Тонкий клиент Яндекс.Музыки (REST API music.yandex.net). */
export class YandexMusic {
  private readonly dispatcher?: Dispatcher;

  constructor(
    private readonly token: string,
    proxy?: string,
  ) {
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  }

  get enabled(): boolean {
    return !!this.token;
  }

  /** fetch с прокси-диспатчером (если задан) — для API и подписи стрима. */
  fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const opts: RequestInit & { dispatcher?: Dispatcher } = { ...init, dispatcher: this.dispatcher };
    return fetch(url, opts);
  }

  private async get(path: string): Promise<Raw> {
    const res = await this.fetch(API + path, { headers: { Authorization: 'OAuth ' + this.token } });
    if (!res.ok) {
      throw new Error(`Yandex ${res.status} ${res.statusText} на ${path}`);
    }
    return res.json();
  }

  private trackToInfo(t: Raw): YmTrack {
    return {
      id: String(t.id ?? t.trackId ?? ''),
      title: t.title ?? '',
      artist: artistsOf(t),
      durationMs: t.durationMs ?? 0,
      coverUrl: cover(t.coverUri ?? t.albums?.[0]?.coverUri, '800x800'),
    };
  }

  // ── Поиск ──────────────────────────────────────────────────────────────────
  async search(text: string, type: YmType, limit = 20): Promise<YmSearchItem[]> {
    if (!text.trim()) return [];
    const r = await this.get(
      `/search?text=${encodeURIComponent(text)}&type=${type}&page=0&nocorrect=true`,
    );
    const res = r.result ?? {};
    if (type === 'track') {
      return (res.tracks?.results ?? []).slice(0, limit).map((t: Raw) => ({
        id: String(t.id),
        name: t.title,
        artist: artistsOf(t),
        type: 'track' as const,
        durationMs: t.durationMs ?? 0,
        coverUrl: cover(t.coverUri ?? t.albums?.[0]?.coverUri, '800x800'),
      }));
    }
    if (type === 'album') {
      return (res.albums?.results ?? []).slice(0, limit).map((a: Raw) => ({
        id: String(a.id),
        name: a.title,
        artist: artistsOf(a),
        year: a.year,
        type: 'album' as const,
        coverUrl: cover(a.coverUri, '800x800'),
      }));
    }
    if (type === 'artist') {
      return (res.artists?.results ?? []).slice(0, limit).map((a: Raw) => ({
        id: String(a.id),
        name: a.name,
        type: 'artist' as const,
        coverUrl: cover(a.cover?.uri, '800x800'),
      }));
    }
    // playlist
    return (res.playlists?.results ?? []).slice(0, limit).map((p: Raw) => ({
      id: `${p.owner?.uid ?? p.uid}:${p.kind}`,
      name: p.title,
      artist: p.owner?.name ?? p.owner?.login,
      type: 'playlist' as const,
      coverUrl: cover(p.cover?.uri || p.ogImage, '800x800'),
    }));
  }

  // ── Треки объекта (для раскрытия/импорта) ───────────────────────────────────
  async getAlbumTracks(albumId: string): Promise<YmTrack[]> {
    const r = await this.get(`/albums/${albumId}/with-tracks`);
    const volumes: Raw[] = r.result?.volumes ?? [];
    return volumes.flat().map((t: Raw) => this.trackToInfo(t));
  }

  async getArtistTracks(artistId: string, limit = 100): Promise<YmTrack[]> {
    const r = await this.get(`/artists/${artistId}/tracks?page=0&page-size=${limit}`);
    return (r.result?.tracks ?? []).map((t: Raw) => this.trackToInfo(t));
  }

  /** playlistId формата "uid:kind". */
  async getPlaylistTracks(playlistId: string): Promise<YmTrack[]> {
    const [uid, kind] = playlistId.split(':');
    const r = await this.get(`/users/${uid}/playlists/${kind}`);
    const tracks: Raw[] = r.result?.tracks ?? [];
    return tracks.map((x: Raw) => this.trackToInfo(x.track ?? x));
  }

  async getTrack(trackId: string): Promise<YmTrack | null> {
    const r = await this.get(`/tracks/${trackId}`);
    const t = Array.isArray(r.result) ? r.result[0] : r.result;
    return t ? this.trackToInfo(t) : null;
  }

  // ── Стрим-URL (download-info → подпись) ──────────────────────────────────────
  async getStreamUrl(trackId: string): Promise<string> {
    return (await this.getStreamInfo(trackId)).url;
  }

  /**
   * То же самое, но заодно отдаёт битрейт выбранного варианта — он и так уже вычисляется
   * при выборе лучшего mp3-качества, просто раньше не возвращался наружу. Нужно для
   * отображения в браузерном плеере (Discord-режим по-прежнему зовёт getStreamUrl()).
   */
  async getStreamInfo(
    trackId: string,
  ): Promise<{ url: string; container: 'mp3'; bitrateKbps?: number }> {
    const di = await this.get(`/tracks/${trackId}/download-info`);
    const options: Raw[] = di.result ?? [];
    const mp3 = options
      .filter((o: Raw) => o.codec === 'mp3')
      .sort((a: Raw, b: Raw) => (b.bitrateInKbps ?? 0) - (a.bitrateInKbps ?? 0))[0];
    if (!mp3?.downloadInfoUrl) throw new Error('Нет mp3-варианта для трека (нужна подписка Плюс?)');

    const xml = await (await this.fetch(mp3.downloadInfoUrl)).text();
    const g = (t: string): string => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1] ?? '';
    const host = g('host');
    const path = g('path');
    const ts = g('ts');
    const s = g('s');
    if (!host || !path) throw new Error('Не удалось разобрать download-info');

    const sign = crypto
      .createHash('md5')
      .update(SIGN_SALT + path.substring(1) + s)
      .digest('hex');
    return {
      url: `https://${host}/get-mp3/${sign}/${ts}${path}`,
      container: 'mp3',
      bitrateKbps: typeof mp3.bitrateInKbps === 'number' ? mp3.bitrateInKbps : undefined,
    };
  }

  // ── Разбор ссылки music.yandex.ru ───────────────────────────────────────────
  resolveLink(input: string): { type: YmType; id: string } | null {
    const url = input.trim();
    // /users/{login}/playlists/{kind}
    let m = url.match(/users\/([^/]+)\/playlists\/(\d+)/i);
    if (m) return { type: 'playlist', id: `${m[1]}:${m[2]}` };
    // /album/{id}/track/{tid}
    m = url.match(/album\/\d+\/track\/(\d+)/i);
    if (m) return { type: 'track', id: m[1]! };
    // /track/{id}
    m = url.match(/track\/(\d+)/i);
    if (m) return { type: 'track', id: m[1]! };
    // /album/{id}
    m = url.match(/album\/(\d+)/i);
    if (m) return { type: 'album', id: m[1]! };
    // /artist/{id}
    m = url.match(/artist\/(\d+)/i);
    if (m) return { type: 'artist', id: m[1]! };
    return null;
  }

  /**
   * Разобрать ссылку → готовый элемент с названием/обложкой и числом треков (count),
   * чтобы панель решила: показать карточкой (≥2 трека) или сразу в очередь (трек/1 трек).
   */
  async resolveLinkItem(input: string): Promise<YmSearchItem | null> {
    const link = this.resolveLink(input);
    if (!link) return null;

    if (link.type === 'track') {
      const t = await this.getTrack(link.id);
      if (!t) return null;
      return {
        id: t.id,
        name: t.title,
        artist: t.artist,
        type: 'track',
        durationMs: t.durationMs,
        coverUrl: t.coverUrl,
        count: 1,
      };
    }

    if (link.type === 'album') {
      const r = await this.get(`/albums/${link.id}/with-tracks`);
      const res = r.result ?? {};
      const tracks: Raw[] = (res.volumes ?? []).flat();
      return {
        id: link.id,
        name: res.title ?? 'Альбом',
        artist: artistsOf(res),
        year: res.year,
        type: 'album',
        coverUrl: cover(res.coverUri, '800x800'),
        count: tracks.length,
      };
    }

    if (link.type === 'artist') {
      const tracks = await this.getArtistTracks(link.id);
      return {
        id: link.id,
        name: tracks[0]?.artist || 'Исполнитель',
        type: 'artist',
        coverUrl: tracks[0]?.coverUrl,
        count: tracks.length,
      };
    }

    // playlist "uid:kind"
    const [uid, kind] = link.id.split(':');
    const r = await this.get(`/users/${uid}/playlists/${kind}`);
    const res = r.result ?? {};
    const tracks: Raw[] = res.tracks ?? [];
    return {
      id: link.id,
      name: res.title ?? 'Плейлист',
      artist: res.owner?.name ?? res.owner?.login,
      type: 'playlist',
      coverUrl: cover(res.cover?.uri || res.ogImage, '800x800'),
      count: tracks.length,
    };
  }
}
