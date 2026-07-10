// Копирует не-TS ассеты Electron (preload.cjs и папку ui) из src/electron в dist/electron.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// Electron-ассеты
const electronDest = path.join(root, 'dist', 'electron');
await mkdir(electronDest, { recursive: true });
await cp(
  path.join(root, 'src', 'electron', 'preload.cjs'),
  path.join(electronDest, 'preload.cjs'),
);
await cp(path.join(root, 'src', 'electron', 'ui'), path.join(electronDest, 'ui'), {
  recursive: true,
});

// Ассеты веб-панели
const webDest = path.join(root, 'dist', 'web', 'ui');
await mkdir(webDest, { recursive: true });
await cp(path.join(root, 'src', 'web', 'ui'), webDest, { recursive: true });

console.log('assets copied → dist/electron, dist/web/ui');
