import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import { buildNowPlayingEmbed } from '../embeds.js';
import type { Command } from '../types.js';

export const nowplaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Что играет сейчас (с прогрессом и обложкой).'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    const np = player?.getNowPlaying();
    if (!np) {
      await interaction.reply({ content: 'Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [buildNowPlayingEmbed(np)] });
  },
};
