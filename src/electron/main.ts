import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import type { SearchType } from '../audio/resolve.js';
import { Bot } from '../core/bot.js';
import { logger } from '../logger.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

let bot: Bot | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 740,
    minWidth: 760,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#0f1116',
    title: 'Jellyfin Discord Bot',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void mainWindow.loadFile(path.join(dirname, 'ui', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('bot:state', () => bot?.getState() ?? null);
  ipcMain.handle('bot:channels', () => bot?.listVoiceChannels() ?? []);
  ipcMain.handle('bot:search', (_e, term: string, type: SearchType) =>
    bot ? bot.search(term, type) : [],
  );
  ipcMain.handle('bot:play', (_e, opts: { channelId: string; query: string; type: SearchType }) =>
    bot ? bot.play(opts) : { ok: false, message: 'Бот не запущен' },
  );
  ipcMain.handle('bot:togglePause', () => bot?.togglePause() ?? false);
  ipcMain.handle('bot:skip', () => bot?.skip() ?? false);
  ipcMain.handle('bot:stop', () => {
    bot?.stop();
  });
  ipcMain.handle('bot:shuffle', () => bot?.shuffle() ?? 0);
  ipcMain.handle('bot:leave', () => {
    bot?.leave();
  });
}

async function startBot(): Promise<void> {
  try {
    bot = new Bot();
    await bot.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Не удалось запустить бота:', msg);
    mainWindow?.webContents.send('bot:error', msg);
  }
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  await startBot();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Трей-режим добавим позже; пока закрытие окна = выход (кроме macOS).
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void bot?.shutdown().catch(() => {});
});
