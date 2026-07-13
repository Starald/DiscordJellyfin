// Копирует не-TS ассеты веб-панели (папку ui) из src/web в dist/web.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// Ассеты веб-панели
const webDest = path.join(root, 'dist', 'web', 'ui');
await mkdir(webDest, { recursive: true });
await cp(path.join(root, 'src', 'web', 'ui'), webDest, { recursive: true });

console.log('assets copied → dist/web/ui');
