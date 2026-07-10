import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { postPanel } from '../panel.js';
import type { Command } from '../types.js';

export const panel: Command = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Показать панель управления плеером (кнопки + прогресс).'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await postPanel(interaction);
  },
};
