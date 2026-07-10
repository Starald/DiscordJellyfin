/** Jellyfin отдаёт длительности в «тиках» по 100 нс. Переводим в миллисекунды. */
export function ticksToMs(ticks: number | undefined): number {
  if (!ticks || ticks <= 0) return 0;
  return Math.round(ticks / 10_000);
}

/** Форматирует миллисекунды в m:ss или h:mm:ss. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}
