import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const leave: Command = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Выйти из голосового канала.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    if (!player) {
      await interaction.reply({ content: 'Меня нет в голосовом канале.', flags: MessageFlags.Ephemeral });
      return;
    }
    player.leave();
    await interaction.reply('👋 Вышел из канала.');
  },
};
