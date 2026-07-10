import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Остановить воспроизведение и очистить очередь.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    if (!player || !player.isActive) {
      await interaction.reply({ content: 'Очередь и так пуста.', flags: MessageFlags.Ephemeral });
      return;
    }
    player.stop();
    await interaction.reply('⏹️ Остановлено, очередь очищена.');
  },
};
