import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { useServices } from '../../services.js';
import type { Command } from '../types.js';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Пропустить текущий трек.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const { players } = useServices();
    const player = players.get(interaction.guildId!);
    const np = player?.getNowPlaying();
    if (!player || !np) {
      await interaction.reply({ content: 'Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });
      return;
    }
    player.skip();
    await interaction.reply(`⏭️ Пропущено: **${np.track.title}**`);
  },
};
