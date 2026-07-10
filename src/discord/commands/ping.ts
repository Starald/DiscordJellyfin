import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types.js';

/** Тестовая команда для Шага 1: проверяем, что бот регистрирует и отвечает на slash-команды. */
export const ping: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Проверка связи: бот отвечает pong и показывает задержку.'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply('Pong! Считаю задержку…');
    const sent = await interaction.fetchReply();
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(
      [
        'Pong! 🏓',
        `Задержка ответа: **${roundtrip} ms**`,
        `WebSocket-heartbeat: **${Math.round(interaction.client.ws.ping)} ms**`,
      ].join('\n'),
    );
  },
};
