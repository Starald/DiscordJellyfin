import { Bot } from './core/bot.js';
import { logger } from './logger.js';
import { startWebPanel } from './web/server.js';

/** Headless-запуск: Discord-бот + веб-панель (сайт ds.starald.ru). */
async function main(): Promise<void> {
  const bot = new Bot();
  await bot.start();
  startWebPanel(bot, bot.config);
}

main().catch((err) => {
  logger.error('Фатальная ошибка при запуске:', err);
  process.exitCode = 1;
});
