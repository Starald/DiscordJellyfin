import {
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { useServices } from '../services.js';
import { itemToTrack } from '../audio/track.js';
import { resolveSelection, type SearchType } from '../audio/resolve.js';
import { buildEnqueuedEmbed } from './embeds.js';
import { getUserVoiceChannel } from './voice.js';

type Anchor = ChatInputCommandInteraction | ModalSubmitInteraction;
type PlayPayload = { content?: string; embeds?: EmbedBuilder[] };

/**
 * Универсальный разбор ввода (как у /play) + постановка в очередь.
 * Принимает текст (поиск по Jellyfin) или ссылку Jellyfin/YouTube/ВК/Яндекса.
 * Сам подключается к каналу. Возвращает payload для editReply (без побочного reply).
 */
export async function runPlayInput(
  interaction: Anchor,
  query: string,
  type: SearchType = 'album',
): Promise<PlayPayload> {
  const { jellyfin, players, bot } = useServices();
  const q = query.trim();
  if (!q) return { content: '❌ Пустой запрос.' };

  const channel = await getUserVoiceChannel(interaction);
  if (!channel) return { content: '❌ Сначала зайди в голосовой канал — я подключусь к тебе.' };

  const me = interaction.guild?.members.me ?? null;
  const perms = me ? channel.permissionsFor(me) : null;
  if (
    !perms?.has(PermissionsBitField.Flags.Connect) ||
    !perms.has(PermissionsBitField.Flags.Speak)
  ) {
    return { content: '❌ Мне не хватает прав **Connect** / **Speak** в этом канале.' };
  }

  // ── Ссылки внешних сервисов (коллекция → все треки, трек/видео → один) ──
  if (/(?:youtube\.com|youtu\.be)/i.test(q)) {
    const r = await bot.ytResolveLink(q).catch(() => null);
    if (!r) return { content: '🔍 Не разобрал ссылку YouTube.' };
    const res =
      r.kind === 'playlist'
        ? await bot.playYouTubePlaylist({ channelId: channel.id, url: r.id })
        : await bot.playYouTube({
            channelId: channel.id,
            videoId: r.video.id,
            title: r.video.title,
            channel: r.video.channel,
            durationMs: r.video.durationMs,
          });
    return { content: (res.ok ? '✅ ' : '❌ ') + res.message };
  }
  if (/vk\.(?:com|ru)/i.test(q)) {
    const item = await bot.vkResolveToItem(q).catch(() => null);
    if (!item) return { content: '🔍 Не разобрал ссылку ВКонтакте.' };
    const res = await bot.playVk({
      channelId: channel.id,
      id: item.id,
      type: item.type,
      title: item.name,
      artist: item.artist,
      durationMs: item.durationMs,
      coverUrl: item.coverUrl,
    });
    return { content: (res.ok ? '✅ ' : '❌ ') + res.message };
  }
  if (/music\.yandex\./i.test(q)) {
    const item = await bot.yandexResolveToItem(q).catch(() => null);
    if (!item) return { content: '🔍 Не разобрал ссылку Яндекс.Музыки.' };
    const res = await bot.playYandex({
      channelId: channel.id,
      id: item.id,
      type: item.type,
      title: item.name,
      artist: item.artist,
      durationMs: item.durationMs,
      coverUrl: item.coverUrl,
    });
    return { content: (res.ok ? '✅ ' : '❌ ') + res.message };
  }

  // ── Jellyfin: текст, Id из автодополнения или ссылка starald.ru ──
  const resolved = await resolveSelection(jellyfin, q, type);
  if (!resolved || resolved.tracks.length === 0) {
    return { content: `🔍 По запросу «${q}» ничего не нашёл.` };
  }
  const player = players.getOrCreate(interaction.guildId!);
  player.connect(channel);
  try {
    await player.ensureReady();
  } catch {
    player.leave();
    return { content: '❌ Не удалось подключиться к голосовому каналу (таймаут).' };
  }
  const startedNow = !player.getNowPlaying();
  const tracks = resolved.tracks.map((item) => itemToTrack(item, jellyfin, interaction.user.id));
  player.enqueue(tracks);
  await player.start();
  return { embeds: [buildEnqueuedEmbed(resolved, tracks, startedNow)] };
}
