import type { JellyfinClient } from '../jellyfin/client.js';
import type { JellyfinItem } from '../jellyfin/types.js';
import { ticksToMs } from '../util/format.js';

/** Доменная модель трека в очереди воспроизведения. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  durationMs: number;
  /** Прямой стрим-URL Jellyfin (содержит api_key — НЕ показывать пользователю). */
  streamUrl: string;
  /** URL обложки без api_key (безопасно вставлять в embed). */
  imageUrl?: string;
  /** Готовый URL обложки для веб-панели (напр. /yt/thumb/{id} для YouTube). */
  thumbUrl?: string;
  /** Discord user id заказавшего трек. */
  requestedBy?: string;
  /** Ленивое получение стрим-URL (YouTube: извлекается yt-dlp на момент воспроизведения). */
  resolve?: () => Promise<string>;
  /** Откуда трек — для пометки/окраски в очереди. */
  source?: 'jellyfin' | 'youtube' | 'yandex' | 'vk';
  /** Прокси для FFmpeg при докачке стрима (ВК/Яндекс, если прямой путь не работает). */
  proxy?: string;
  /** Статус предзагрузки (резолва) для головы очереди — для отображения в панели. Транзиентное. */
  prefetchState?: 'loading' | 'ready' | 'error';
  /** Внутреннее: текущий идущий resolve (мемоизация, чтобы не резолвить дважды). Транзиентное. */
  resolving?: Promise<void>;
}

/** Преобразует элемент Jellyfin (Audio) в трек с готовым стрим-URL и обложкой. */
export function itemToTrack(
  item: JellyfinItem,
  jellyfin: JellyfinClient,
  requestedBy?: string,
): Track {
  const artist =
    (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : undefined) ??
    item.AlbumArtist ??
    'Неизвестный исполнитель';
  const imageItemId = item.AlbumId ?? item.Id;
  const imageTag = item.AlbumPrimaryImageTag ?? item.ImageTags?.Primary;

  return {
    id: item.Id,
    title: item.Name,
    artist,
    album: item.Album,
    albumId: item.AlbumId,
    durationMs: ticksToMs(item.RunTimeTicks),
    streamUrl: jellyfin.getStreamUrl(item.Id),
    imageUrl: jellyfin.getPrimaryImageUrl(imageItemId, imageTag),
    requestedBy,
    source: 'jellyfin',
  };
}
