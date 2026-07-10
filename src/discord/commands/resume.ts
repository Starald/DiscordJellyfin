import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Продолжить воспроизведение после паузы.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    if (!player || !player.getNowPlaying()) {
      await interaction.reply({ content: 'Нечего возобновлять.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!player.isPaused) {
      await interaction.reply({ content: '▶️ Уже играет.', flags: MessageFlags.Ephemeral });
      return;
    }
    player.resume();
    await interaction.reply('▶️ Продолжаю.');
  },
};
