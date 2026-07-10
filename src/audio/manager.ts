import type { AppConfig } from '../config.js';
import { GuildMusicPlayer, type HistoryItem } from './player.js';

/** Адаптер сохранения истории на диск (seed при создании плеера + сохранение при изменении). */
export interface HistoryAdapter {
  load(): HistoryItem[];
  onChange(items: HistoryItem[]): void;
}

/** Хранит по одному плееру на гильдию. */
export class PlayerManager {
  private readonly players = new Map<string, GuildMusicPlayer>();

  constructor(
    private readonly config: AppConfig,
    private readonly history?: HistoryAdapter,
  ) {}

  get(guildId: string): GuildMusicPlayer | undefined {
    return this.players.get(guildId);
  }

  getOrCreate(guildId: string): GuildMusicPlayer {
    let player = this.players.get(guildId);
    if (!player) {
      player = new GuildMusicPlayer(
        guildId,
        this.config.idleTimeoutMs,
        (id) => this.players.delete(id),
        this.history
          ? { history: this.history.load(), onHistoryChange: (items) => this.history!.onChange(items) }
          : undefined,
      );
      this.players.set(guildId, player);
    }
    return player;
  }
}
