import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Перемешать очередь.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    if (!player || player.getSnapshot().upcoming.length < 2) {
      await interaction.reply({
        content: 'В очереди недостаточно треков для перемешивания.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const count = player.shuffle();
    await interaction.reply(`🔀 Перемешал очередь (${count} трек(ов)).`);
  },
};
