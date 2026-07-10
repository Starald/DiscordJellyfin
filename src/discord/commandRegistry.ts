import { REST, Routes } from 'discord.js';
import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import { commands } from './commands/index.js';

/**
 * Регистрирует slash-команды.
 * commandScope='guild'  — на DISCORD_GUILD_ID (мгновенно, для разработки/одного сервера).
 * commandScope='global' — глобально (видны на всех серверах бота, появляются до ~1 часа).
 */
export async function registerCommands(config: AppConfig): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const body = commands.map((command) => command.data.toJSON());
  const list = commands.map((c) => `/${c.data.name}`).join(', ');

  if (config.discord.commandScope === 'global') {
    logger.info(`Регистрирую ${body.length} slash-команд(ы) глобально: ${list}`);
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
  } else {
    logger.info(
      `Регистрирую ${body.length} slash-команд(ы) на гильдии ${config.discord.guildId}: ${list}`,
    );
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body },
    );
  }

  logger.info('Slash-команды зарегистрированы.');
}
