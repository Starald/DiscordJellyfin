import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const pause: Command = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Поставить на паузу или снять с паузы (переключатель).'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    if (!player || !player.getNowPlaying()) {
      await interaction.reply({ content: 'Нечего ставить на паузу.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Переключатель: на паузе → снимаем, играет → ставим.
    if (player.isPaused) {
      player.resume();
      await interaction.reply('▶️ Снял с паузы.');
    } else {
      player.pause();
      await interaction.reply('⏸️ Пауза.');
    }
  },
};
