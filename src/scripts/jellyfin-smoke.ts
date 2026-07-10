/**
 * Smoke-тест Jellyfin (Шаг 2 плана).
 * Проверяет всю цепочку: аутентификация → версия сервера → поиск альбома →
 * треки по порядку → реальная отдача аудио по стрим-URL.
 *
 * Запуск:  npm run jellyfin:smoke -- "название альбома"
 * Без аргумента просто покажет первые альбомы библиотеки.
 */
import { loadConfig } from '../config.js';
import { JellyfinClient } from '../jellyfin/client.js';
import { formatDuration, ticksToMs } from '../util/format.js';

function redactKey(url: string): string {
  return url.replace(/(api_key=)[^&]+/, '$1***');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new JellyfinClient({
    baseUrl: config.jellyfin.url,
    apiKey: config.jellyfin.apiKey,
  });

  const searchTerm = process.argv.slice(2).join(' ').trim();

  console.log('── 1. Подключение к Jellyfin ──────────────────────────────');
  console.log(`URL: ${config.jellyfin.url}`);
  const info = await client.getSystemInfo();
  console.log(`Сервер: ${info.ServerName ?? '?'}  |  версия: ${info.Version ?? '?'}`);
  console.log(`ОС: ${info.OperatingSystem ?? '?'}`);

  console.log('\n── 2. Поиск альбомов ──────────────────────────────────────');
  console.log(searchTerm ? `Запрос: "${searchTerm}"` : 'Запрос пустой → первые альбомы библиотеки');
  const albums = await client.searchAlbums(searchTerm, 10);
  if (albums.length === 0) {
    console.log('Альбомы не найдены. Проверь запрос или наличие музыкальной библиотеки.');
    return;
  }
  albums.forEach((album, i) => {
    const artist = album.AlbumArtist ?? album.Artists?.join(', ') ?? '—';
    const year = album.ProductionYear ? ` (${album.ProductionYear})` : '';
    console.log(`  ${i + 1}. ${artist} — ${album.Name}${year}  [id: ${album.Id}]`);
  });

  const target = albums[0];
  console.log(`\n── 3. Треки альбома: "${target.Name}" ──────────────────────`);
  const tracks = await client.getAlbumTracks(target.Id);
  if (tracks.length === 0) {
    console.log('У альбома нет треков (или нет прав). Останавливаюсь.');
    return;
  }
  let totalMs = 0;
  tracks.forEach((track) => {
    const ms = ticksToMs(track.RunTimeTicks);
    totalMs += ms;
    const disc = track.ParentIndexNumber ? `${track.ParentIndexNumber}.` : '';
    const num = track.IndexNumber ?? '?';
    console.log(`  ${disc}${num}. ${track.Name}  [${formatDuration(ms)}]`);
  });
  console.log(`Итого: ${tracks.length} треков, ${formatDuration(totalMs)}`);

  console.log('\n── 4. Проверка стрим-URL (реально ли отдаётся аудио) ──────');
  const first = tracks[0];
  const streamUrl = client.getStreamUrl(first.Id);
  console.log(`Трек: ${first.Name}`);
  console.log(`URL:  ${redactKey(streamUrl)}`);
  const res = await fetch(streamUrl, { headers: { Range: 'bytes=0-65535' } });
  console.log(`Статус:        ${res.status} ${res.statusText}`);
  console.log(`Content-Type:  ${res.headers.get('content-type') ?? '—'}`);
  console.log(`Content-Length:${res.headers.get('content-length') ?? '—'}`);
  console.log(`Content-Range: ${res.headers.get('content-range') ?? '—'}`);
  await res.body?.cancel();

  const ok = res.ok && (res.headers.get('content-type') ?? '').match(/audio|octet-stream|ogg|mpeg/i);
  console.log(`\n${ok ? '✅ Аудио отдаётся — цепочка Jellyfin рабочая.' : '⚠️  Статус/тип подозрительны — посмотри ответ выше.'}`);
}

main().catch((err) => {
  console.error('\n❌ Smoke-тест упал:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
