import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import type { HistoryItem } from '../audio/player.js';

const FILE = path.join(process.cwd(), 'state.json');

export interface PersistedState {
  /** Последний голосовой канал, куда играл бот. */
  lastChannelId?: string;
  /** История недавно проигранных треков. */
  history?: HistoryItem[];
}

export function loadState(): PersistedState {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as PersistedState;
  } catch {
    return {};
  }
}

/** Частичное обновление: сливаем с тем, что уже на диске (чтобы не затирать другие поля). */
export function saveState(patch: PersistedState): void {
  try {
    const next = { ...loadState(), ...patch };
    writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    logger.warn('Не удалось сохранить state.json:', err instanceof Error ? err.message : err);
  }
}
