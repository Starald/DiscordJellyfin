import type { Command } from '../types.js';
import { leave } from './leave.js';
import { nowplaying } from './nowplaying.js';
import { panel } from './panel.js';
import { pause } from './pause.js';
import { ping } from './ping.js';
import { play } from './play.js';
import { queue } from './queue.js';
import { resume } from './resume.js';
import { shuffle } from './shuffle.js';
import { skip } from './skip.js';
import { stop } from './stop.js';

/** Все команды бота. Новые команды добавляй сюда. */
export const commands: Command[] = [
  ping,
  play,
  queue,
  skip,
  pause,
  resume,
  stop,
  nowplaying,
  shuffle,
  leave,
  panel,
];

/** Быстрый доступ по имени команды для роутинга интеракций. */
export const commandMap = new Map<string, Command>(
  commands.map((command) => [command.data.name, command]),
);
