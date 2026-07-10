import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { useServices } from '../services.js';
import { formatDuration } from '../util/format.js';
import { buildQueueEmbed } from './embeds.js';
import { runPlayInput } from './playInput.js';
import { getUserVoiceChannel } from './voice.js';
import type { GuildMusicPlayer, HistoryItem } from '../audio/player.js';
import type { Track } from '../audio/track.js';
import { logger } from '../logger.js';

const ACCENT = 0x00a4dc;
const REFRESH_MS = 1000;
const SEEK_STEP_MS = 15_000;

const SOURCE_LABEL: Record<string, string> = {
  jellyfin: 'Jellyfin',
  youtube: 'YouTube',
  yandex: 'Яндекс.Музыка',
  vk: 'ВКонтакте',
};

/** Активные «живые» панели по гильдиям (одна на гильдию). */
const panels = new Map<string, { message: Message; timer: NodeJS.Timeout; key: string }>();

function progressBar(playbackMs: number, durationMs: number, size = 20): string {
  if (durationMs <= 0) return '▬'.repeat(size);
  const ratio = Math.min(1, Math.max(0, playbackMs / durationMs));
  const pos = Math.min(size - 1, Math.floor(ratio * size));
  return '▬'.repeat(pos) + '🔘' + '▬'.repeat(size - 1 - pos);
}

/** Локальный/приватный хост — Discord до него не достучится. */
function isLocalHost(u: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
    u,
  );
}

/** Локальный Jellyfin-URL → публичный (Discord тянет картинку со своих серверов). */
function toPublic(u: string): string | null {
  if (!isLocalHost(u)) return u; // уже публичный (VK/Яндекс CDN и т.п.)
  let base: string | undefined;
  try {
    base = useServices().config.jellyfin.publicUrl;
  } catch {
    base = undefined;
  }
  if (!base) return null; // публичный домен не задан — лучше без картинки, чем битая ссылка
  return u.replace(/^https?:\/\/[^/]+/i, base.replace(/\/+$/, ''));
}

/** Абсолютный URL обложки, который сможет подтянуть Discord. */
function publicArt(track: Track): string | null {
  if (track.source === 'youtube') {
    return `https://i.ytimg.com/vi/${track.id.replace(/^yt-/, '')}/mqdefault.jpg`;
  }
  if (track.thumbUrl && /^https?:\/\//i.test(track.thumbUrl)) return toPublic(track.thumbUrl);
  if (track.imageUrl && /^https?:\/\//i.test(track.imageUrl)) return toPublic(track.imageUrl);
  return null;
}

function button(id: string, emoji: string, style: ButtonStyle, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style).setDisabled(disabled);
}

/** Сигнатура состояния — чтобы не редактировать сообщение, когда ничего не изменилось. */
function panelKey(player: GuildMusicPlayer | undefined): string {
  const np = player?.getNowPlaying();
  const snap = player?.getSnapshot();
  if (!np) return 'idle';
  return [
    np.track.id,
    np.paused ? 'p' : 'r',
    np.buffering ? 'b' : '',
    Math.floor(np.playbackMs / REFRESH_MS),
    snap?.upcoming.length ?? 0,
    player?.isLooping ? 'L' : '',
  ].join('|');
}

/** Собирает payload панели (Components V2 — всё в одном блоке-контейнере). */
export function buildPanel(player: GuildMusicPlayer | undefined): {
  components: ContainerBuilder[];
  flags: number;
  allowedMentions: { parse: [] };
} {
  const np = player?.getNowPlaying() ?? null;
  const snap = player?.getSnapshot();
  const looping = player?.isLooping ?? false;
  const paused = np?.paused ?? false;
  const playing = !!np;

  const container = new ContainerBuilder().setAccentColor(ACCENT);

  if (!np) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('Ничего не играет'),
    );
  } else {
    const t = np.track;
    const header = np.buffering ? 'Загрузка…' : paused ? 'На паузе' : 'Сейчас играет';
    const info =
      `-# ${header}\n## ${t.title || 'Без названия'}\n${t.artist || '—'}` +
      (t.album ? `\n*${t.album}*` : '');
    const bar = `\`${formatDuration(np.playbackMs)}\` ${progressBar(np.playbackMs, t.durationMs)} \`${formatDuration(t.durationMs)}\``;
    const art = publicArt(t);

    if (art) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(info),
            new TextDisplayBuilder().setContent(bar),
          )
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(art)),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(info),
        new TextDisplayBuilder().setContent(bar),
      );
    }

    const src = SOURCE_LABEL[t.source ?? ''] ?? 'Музыка';
    const req = t.requestedBy ? ` • Добавил: <@${t.requestedBy}>` : '';
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${src} • Треков в очереди: ${snap?.upcoming.length ?? 0}${req}`,
      ),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('panel:back15', '⏪', ButtonStyle.Secondary, !playing),
    button('panel:restart', '⏮️', ButtonStyle.Secondary, !playing),
    button('panel:pause', paused ? '▶️' : '⏸️', ButtonStyle.Primary, !playing),
    button('panel:skip', '⏭️', ButtonStyle.Secondary, !playing),
    button('panel:fwd15', '⏩', ButtonStyle.Secondary, !playing),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('panel:shuffle', '🔀', ButtonStyle.Secondary, !playing),
    button('panel:loop', '🔁', looping ? ButtonStyle.Success : ButtonStyle.Secondary, !playing),
    button('panel:queue', '📋', ButtonStyle.Secondary, false),
    button('panel:stop', '⏹️', ButtonStyle.Danger, !playing),
    button('panel:leave', '🚪', ButtonStyle.Danger, false),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('panel:add')
      .setEmoji('➕')
      .setLabel('Поиск / ссылка')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('panel:history')
      .setEmoji('🕘')
      .setLabel('История')
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row1);
  container.addActionRowComponents(row2);
  container.addActionRowComponents(row3);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }, // не пинговать заказчика при каждом обновлении
  };
}

function stopLive(guildId: string): void {
  const p = panels.get(guildId);
  if (p) {
    clearInterval(p.timer);
    panels.delete(guildId);
  }
}

function startLive(guildId: string, message: Message): void {
  stopLive(guildId);
  const timer = setInterval(() => {
    const { players } = useServices();
    const player = players.get(guildId);
    const entry = panels.get(guildId);
    if (!entry) return;
    const key = panelKey(player);
    if (key === entry.key) return; // ничего не изменилось — не дёргаем Discord
    entry.key = key;
    message.edit(buildPanel(player)).catch(() => stopLive(guildId));
  }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  panels.set(guildId, { message, timer, key: panelKey(useServices().players.get(guildId)) });
}

/** Команда /panel: публикует панель и запускает живое обновление. */
export async function postPanel(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Только на сервере.', flags: MessageFlags.Ephemeral });
    return;
  }
  const { players } = useServices();
  await interaction.reply(buildPanel(players.get(guildId)));
  const message = await interaction.fetchReply();
  startLive(guildId, message);
}

/** Обработка нажатий кнопок панели (customId начинается с "panel:"). */
export async function handlePanelButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const { players } = useServices();
  const player = players.get(guildId);
  const id = interaction.customId;

  // Поиск/ссылка — открываем модалку для ввода (showModal должен быть первым ответом).
  if (id === 'panel:add') {
    const input = new TextInputBuilder()
      .setCustomId('query')
      .setLabel('Название (Jellyfin) или ссылка')
      .setPlaceholder('Поиск по Jellyfin или ссылка YouTube / ВК / Яндекс')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(400);
    const modal = new ModalBuilder()
      .setCustomId('panel:addModal')
      .setTitle('Добавить в очередь')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // Очередь — отдельным эфемерным сообщением, панель не трогаем.
  if (id === 'panel:queue') {
    const snap = player?.getSnapshot() ?? { current: null, upcoming: [], paused: false };
    await interaction.reply({ embeds: [buildQueueEmbed(snap)], flags: MessageFlags.Ephemeral });
    return;
  }

  // История — эфемерный диалог с двумя меню (в конец / в начало).
  if (id === 'panel:history') {
    await interaction.reply({ ...buildHistoryDialog(), flags: MessageFlags.Ephemeral });
    return;
  }

  if (player) {
    const np = player.getNowPlaying();
    switch (id) {
      case 'panel:pause':
        if (np) (player.isPaused ? player.resume() : player.pause());
        break;
      case 'panel:skip':
        player.skip();
        break;
      case 'panel:stop':
        player.stop();
        break;
      case 'panel:shuffle':
        player.shuffle();
        break;
      case 'panel:loop':
        player.toggleLoop();
        break;
      case 'panel:leave':
        player.leave();
        stopLive(guildId);
        break;
      case 'panel:restart':
        if (np) player.seek(0);
        break;
      case 'panel:back15':
        if (np) player.seek(Math.max(0, np.playbackMs - SEEK_STEP_MS));
        break;
      case 'panel:fwd15':
        if (np) player.seek(np.playbackMs + SEEK_STEP_MS);
        break;
    }
  }

  try {
    await interaction.update(buildPanel(players.get(guildId)));
    const entry = panels.get(guildId);
    if (entry) entry.key = panelKey(players.get(guildId));
  } catch (err) {
    logger.warn('panel update error:', err instanceof Error ? err.message : err);
  }
}

/** Немедленно обновить живую панель гильдии (после добавления трека и т.п.). */
export function refreshPanel(guildId: string): void {
  const entry = panels.get(guildId);
  if (!entry) return;
  const player = useServices().players.get(guildId);
  entry.key = panelKey(player);
  entry.message.edit(buildPanel(player)).catch(() => stopLive(guildId));
}

/** Сабмит модалки поиска: тот же разбор, что и /play. */
export async function handlePanelModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId) return;
  const query = interaction.fields.getTextInputValue('query');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const payload = await runPlayInput(interaction, query);
  await interaction.editReply(payload);
  refreshPanel(interaction.guildId);
}

/** Уникальная (по id) история для показа в меню (из сохранённого состояния). */
function uniqueHistory(): HistoryItem[] {
  const seen = new Set<string>();
  const out: HistoryItem[] = [];
  for (const t of useServices().bot.getRecentHistory()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= 25) break;
  }
  return out;
}

/** Диалог истории: текст + два select-меню (в конец / в начало очереди). */
function buildHistoryDialog(status?: string): {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
} {
  const hist = uniqueHistory();
  if (hist.length === 0) {
    return { content: '🕘 История пуста — ещё ничего не играло.', components: [] };
  }

  const makeOptions = () =>
    hist.map((t) =>
      new StringSelectMenuOptionBuilder()
        .setLabel((t.title || 'Без названия').slice(0, 100))
        .setDescription(
          `${t.artist || '—'} • ${SOURCE_LABEL[t.source ?? ''] ?? 'Музыка'}`.slice(0, 100),
        )
        .setValue(t.id.slice(0, 100)),
    );

  const endMenu = new StringSelectMenuBuilder()
    .setCustomId('hist:end')
    .setPlaceholder('➕ Добавить в КОНЕЦ очереди')
    .addOptions(makeOptions());
  const startMenu = new StringSelectMenuBuilder()
    .setCustomId('hist:start')
    .setPlaceholder('⤒ Добавить в НАЧАЛО очереди')
    .addOptions(makeOptions());

  const head = (status ? `${status}\n\n` : '') + '🕘 **История прослушиваний** — выбери трек:';
  return {
    content: head,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(endMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(startMenu),
    ],
  };
}

/** Выбор трека из истории → добавить в конец/начало очереди. */
export async function handleHistorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const { bot } = useServices();
  const trackId = interaction.values[0];

  const channel = await getUserVoiceChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: '❌ Сначала зайди в голосовой канал.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const position = interaction.customId === 'hist:start' ? 'next' : 'end';
  const res = await bot.playFromHistory(channel.id, trackId, position);
  refreshPanel(guildId);

  const status = (res.ok ? '✅ ' : '❌ ') + res.message;
  await interaction.update(buildHistoryDialog(status));
}
