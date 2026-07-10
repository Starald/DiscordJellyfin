import type { JellyfinClient } from '../jellyfin/client.js';
import type { JellyfinItem } from '../jellyfin/types.js';

export type SearchType = 'album' | 'artist' | 'playlist' | 'track';

export interface ResolvedSelection {
  kind: SearchType;
  /** Сам выбранный объект (альбом/исполнитель/плейлист/трек). */
  item: JellyfinItem;
  /** Развёрнутый список аудио-треков в порядке воспроизведения. */
  tracks: JellyfinItem[];
}

export function typeToItemTypes(type: SearchType): string[] {
  switch (type) {
    case 'album':
      return ['MusicAlbum'];
    case 'artist':
      return ['MusicArtist'];
    case 'playlist':
      return ['Playlist'];
    case 'track':
      return ['Audio'];
  }
}

async function expand(
  jellyfin: JellyfinClient,
  item: JellyfinItem,
  fallbackType: SearchType,
): Promise<ResolvedSelection> {
  const type = item.Type ?? '';
  if (type === 'MusicAlbum' || (type === '' && fallbackType === 'album')) {
    return { kind: 'album', item, tracks: await jellyfin.getAlbumTracks(item.Id) };
  }
  if (type === 'MusicArtist' || (type === '' && fallbackType === 'artist')) {
    return { kind: 'artist', item, tracks: await jellyfin.getArtistTracks(item.Id) };
  }
  if (type === 'Playlist' || (type === '' && fallbackType === 'playlist')) {
    return { kind: 'playlist', item, tracks: await jellyfin.getPlaylistTracks(item.Id) };
  }
  return { kind: 'track', item, tracks: [item] };
}

/**
 * Превращает пользовательский запрос (текст ИЛИ Jellyfin Id из автодополнения)
 * в выбранный объект и список треков.
 */
export async function resolveSelection(
  jellyfin: JellyfinClient,
  query: string,
  type: SearchType,
): Promise<ResolvedSelection | null> {
  const trimmed = query.trim();
  // Автодополнение присылает value = Jellyfin Id (32 hex). Вытаскиваем его из строки,
  // даже если затесались лишние символы (напр. trailing «\»).
  const idMatch = trimmed.match(/[0-9a-f]{32}/i);

  let item: JellyfinItem | null = null;
  if (idMatch) {
    item = await jellyfin.getItem(idMatch[0]).catch(() => null);
  }
  if (!item) {
    const results = await jellyfin.searchItems(trimmed, typeToItemTypes(type), 1);
    item = results[0] ?? null;
  }
  if (!item) return null;

  return expand(jellyfin, item, type);
}
