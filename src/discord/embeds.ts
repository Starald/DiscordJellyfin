import { EmbedBuilder } from 'discord.js';
import type { NowPlaying, QueueSnapshot } from '../audio/player.js';
import type { ResolvedSelection } from '../audio/resolve.js';
import type { Track } from '../audio/track.js';
import { formatDuration } from '../util/format.js';

const ACCENT = 0x00a4dc; // фирменный синий Jellyfin
const QUEUE_PAGE = 15;

function progressBar(playbackMs: number, durationMs: number, size = 18): string {
  if (durationMs <= 0) return '▬'.repeat(size);
  const ratio = Math.min(1, Math.max(0, playbackMs / durationMs));
  const pos = Math.min(size - 1, Math.floor(ratio * size));
  return '▬'.repeat(pos) + '🔘' + '▬'.repeat(size - 1 - pos);
}

const KIND_LABEL: Record<ResolvedSelection['kind'], string> = {
  album: 'Альбом',
  artist: 'Исполнитель',
  playlist: 'Плейлист',
  track: 'Трек',
};

export function buildNowPlayingEmbed(np: NowPlaying): EmbedBuilder {
  const { track, playbackMs, paused } = np;
  const bar = progressBar(playbackMs, track.durationMs);
  const time = `\`${formatDuration(playbackMs)}\` ${bar} \`${formatDuration(track.durationMs)}\``;

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: paused ? '⏸️ На паузе' : '▶️ Сейчас играет' })
    .setTitle(track.title)
    .setDescription(track.artist + (track.album ? `\n*${track.album}*` : ''))
    .addFields({ name: '​', value: time });

  if (track.imageUrl) embed.setThumbnail(track.imageUrl);
  return embed;
}

export function buildQueueEmbed(snapshot: QueueSnapshot): EmbedBuilder {
  const { current, upcoming, paused } = snapshot;
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle('🎶 Очередь');
  const lines: string[] = [];

  if (current) {
    lines.push(
      `${paused ? '⏸️' : '▶️'} **${current.title}** — ${current.artist} \`${formatDuration(current.durationMs)}\``,
    );
  } else {
    lines.push('_Сейчас ничего не играет._');
  }

  if (upcoming.length > 0) {
    lines.push('', '**Далее:**');
    const shown = upcoming.slice(0, QUEUE_PAGE);
    shown.forEach((t, i) => {
      lines.push(`\`${i + 1}.\` ${t.title} — ${t.artist} \`${formatDuration(t.durationMs)}\``);
    });
    if (upcoming.length > shown.length) {
      lines.push(`…и ещё **${upcoming.length - shown.length}**`);
    }
    const totalMs = upcoming.reduce((sum, t) => sum + t.durationMs, 0);
    embed.setFooter({ text: `В очереди: ${upcoming.length} • ${formatDuration(totalMs)}` });
  }

  embed.setDescription(lines.join('\n'));
  return embed;
}

export function buildEnqueuedEmbed(
  resolved: ResolvedSelection,
  tracks: Track[],
  startedNow: boolean,
): EmbedBuilder {
  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const header = startedNow ? '▶️ Играю' : '➕ Добавлено в очередь';

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: header })
    .setTitle(resolved.item.Name)
    .setDescription(`${KIND_LABEL[resolved.kind]} • ${tracks.length} трек(ов) • ${formatDuration(totalMs)}`);

  const firstWithArt = tracks.find((t) => t.imageUrl);
  if (firstWithArt?.imageUrl) embed.setThumbnail(firstWithArt.imageUrl);
  return embed;
}
