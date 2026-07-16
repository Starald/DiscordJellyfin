/** Подмножество ответов Jellyfin REST API, которое реально использует бот. */

export interface SystemInfo {
  ServerName?: string;
  Version?: string;
  Id?: string;
  OperatingSystem?: string;
  ProductName?: string;
}

export interface NameGuidPair {
  Name?: string;
  Id?: string;
}

export interface JellyfinMediaSource {
  Container?: string;
  /** Битрейт всего источника в бит/с (аудиофайлы — практически всегда только звук). */
  Bitrate?: number;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type?: string; // MusicAlbum | Audio | MusicArtist | Playlist ...
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  AlbumArtists?: NameGuidPair[];
  Artists?: string[];
  ArtistItems?: NameGuidPair[];
  ProductionYear?: number;
  IndexNumber?: number; // номер трека
  ParentIndexNumber?: number; // номер диска
  RunTimeTicks?: number;
  ChildCount?: number;
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
  /** Запрашивается через Fields=MediaSources — формат/битрейт для браузерного плеера. */
  MediaSources?: JellyfinMediaSource[];
}

export interface ItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
  StartIndex: number;
}
