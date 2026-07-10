import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { useServices } from '../../services.js';
import { type SearchType } from '../../audio/resolve.js';
import { runPlayInput } from '../playInput.js';
import type { Command } from '../types.js';

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Поиск по Jellyfin или ссылка (Jellyfin / YouTube / ВК / Яндекс).')
    .addStringOption((o) =>
      o
        .setName('query')
        .setDescription('Название для поиска по Jellyfin или ссылка (Jellyfin/YouTube/ВК/Яндекс)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Что искать (по умолчанию — альбом)')
        .addChoices(
          { name: 'Альбом', value: 'album' },
          { name: 'Исполнитель', value: 'artist' },
          { name: 'Плейлист', value: 'playlist' },
          { name: 'Трек', value: 'track' },
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const query = interaction.options.getString('query', true);
    const type = (interaction.options.getString('type') as SearchType | null) ?? 'album';
    const payload = await runPlayInput(interaction, query, type);
    await interaction.editReply(payload);
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const { jellyfin } = useServices();
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'query') {
      await interaction.respond([]);
      return;
    }

    const term = String(focused.value).trim();
    // Ссылку по Jellyfin искать не нужно — пользователь просто отправит её как есть.
    if (
      !term ||
      /^https?:\/\/|youtube\.com|youtu\.be|vk\.(?:com|ru)|music\.yandex\./i.test(term)
    ) {
      await interaction.respond([]);
      return;
    }

    // Ищем по каждому типу отдельно и чередуем, чтобы в выдаче были все типы
    // (один общий запрос забивается треками). Тип помечаем цветным кружком —
    // цвет текста в автодополнении Discord не поддерживает.
    const TYPES = [
      { itemType: 'MusicAlbum', emoji: '🔴', ru: 'Альбом' },
      { itemType: 'Audio', emoji: '🔵', ru: 'Трек' },
      { itemType: 'Playlist', emoji: '🟡', ru: 'Плейлист' },
      { itemType: 'MusicArtist', emoji: '🟣', ru: 'Исполнитель' },
    ];
    const perType = await Promise.all(
      TYPES.map((t) => jellyfin.searchItems(term, [t.itemType], 8).catch(() => [])),
    );

    const choices: { name: string; value: string }[] = [];
    for (let i = 0; i < 8 && choices.length < 25; i++) {
      for (let t = 0; t < TYPES.length && choices.length < 25; t++) {
        const item = perType[t]![i];
        if (!item) continue;
        const meta = TYPES[t]!;
        const artist =
          (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : undefined) ??
          item.AlbumArtist;
        const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
        const title =
          meta.itemType !== 'MusicArtist' && artist ? `${artist} — ${item.Name}` : item.Name;
        // value = Id: execute заберёт точный объект (resolveSelection вытащит id).
        choices.push({
          name: `${meta.emoji} ${meta.ru}: ${title}${year}`.slice(0, 100),
          value: item.Id,
        });
      }
    }

    await interaction.respond(choices);
  },
};
