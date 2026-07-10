import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import { buildQueueEmbed } from '../embeds.js';
import type { Command } from '../types.js';

export const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Показать текущую очередь.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    const snapshot = player?.getSnapshot();
    if (!snapshot || (!snapshot.current && snapshot.upcoming.length === 0)) {
      await interaction.reply({ content: 'Очередь пуста.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [buildQueueEmbed(snapshot)] });
  },
};
