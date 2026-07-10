import type { AppConfig } from './config.js';
import type { JellyfinClient } from './jellyfin/client.js';
import type { PlayerManager } from './audio/manager.js';
import type { Bot } from './core/bot.js';

/** Общие зависимости, доступные командам. Инициализируются в index.ts на старте. */
export interface Services {
  config: AppConfig;
  jellyfin: JellyfinClient;
  players: PlayerManager;
  /** Ядро бота — для слэш-команд, работающих с YouTube/ВК/Яндексом по ссылке. */
  bot: Bot;
}

let services: Services | undefined;

export function setServices(value: Services): void {
  services = value;
}

export function useServices(): Services {
  if (!services) throw new Error('Services ещё не инициализированы');
  return services;
}
