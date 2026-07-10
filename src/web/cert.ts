import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = process.cwd();
const DEPLOY_DIR = path.join(PROJECT_ROOT, 'deploy');
const CERT_DIR = path.join(DEPLOY_DIR, 'certs');
const SNIPPET = path.join(CERT_DIR, 'ds-tls.caddy');
const FULLCHAIN = path.join(CERT_DIR, 'fullchain.pem');
const KEYFILE = path.join(CERT_DIR, 'key.pem');
const CADDYFILE = path.join(DEPLOY_DIR, 'Caddyfile');

const PANEL_HOST = 'ds.starald.ru';

function firstExisting(candidates: string[], fallback: string): string {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return fallback;
}

const OPENSSL =
  process.env.OPENSSL_PATH ??
  firstExisting(
    ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'],
    'openssl',
  );

const CADDY =
  process.env.CADDY_PATH ??
  firstExisting(
    [
      path.join(
        process.env.LOCALAPPDATA ?? '',
        'Microsoft\\WinGet\\Packages\\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\\caddy.exe',
      ),
    ],
    'caddy',
  );

export interface CertInfo {
  mode: 'letsencrypt' | 'custom';
  subject?: string;
  sans?: string[];
  notAfter?: string;
  coversPanel?: boolean;
}

function ensureDir(): void {
  mkdirSync(CERT_DIR, { recursive: true });
}

function writeSnippet(content: string): void {
  ensureDir();
  writeFileSync(SNIPPET, content, 'utf8');
}

async function reloadCaddy(): Promise<void> {
  await execFileAsync(CADDY, ['reload', '--config', CADDYFILE]);
}

function rmSafe(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

export function getCertInfo(): CertInfo {
  let custom = false;
  try {
    custom = /^\s*tls\s+/m.test(readFileSync(SNIPPET, 'utf8'));
  } catch {
    /* нет сниппета — LE */
  }
  if (!custom || !existsSync(FULLCHAIN)) return { mode: 'letsencrypt' };

  try {
    const cert = new X509Certificate(readFileSync(FULLCHAIN));
    const sans = (cert.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/i, ''))
      .filter(Boolean);
    const coversPanel = sans.some(
      (s) => s === PANEL_HOST || (s.startsWith('*.') && PANEL_HOST.endsWith(s.slice(1))),
    );
    return { mode: 'custom', subject: cert.subject, sans, notAfter: cert.validTo, coversPanel };
  } catch (err) {
    logger.warn('Не удалось разобрать сертификат:', err instanceof Error ? err.message : err);
    return { mode: 'custom' };
  }
}

/** Ставит уже подготовленные cert/key (из временных файлов), перезагружает Caddy, при сбое — откат на LE. */
async function commitAndReload(srcCert: string, srcKey: string): Promise<CertInfo> {
  // Проверяем, что сертификат вообще парсится.
  new X509Certificate(readFileSync(srcCert));

  copyFileSync(srcCert, FULLCHAIN);
  copyFileSync(srcKey, KEYFILE);
  writeSnippet(`tls ${FULLCHAIN.replace(/\\/g, '/')} ${KEYFILE.replace(/\\/g, '/')}\n`);

  try {
    await reloadCaddy();
  } catch (err) {
    // Безопасный откат: возвращаем авто-LE, чтобы сайт не остался без рабочего TLS.
    writeSnippet("# Auto Let's Encrypt (откат после неудачной загрузки сертификата).\n");
    await reloadCaddy().catch(() => {});
    throw new Error(
      'Caddy не принял сертификат — откатил на Let\'s Encrypt. ' +
        (err instanceof Error ? err.message : ''),
    );
  }
  return getCertInfo();
}

export async function applyPem(certPem: string, keyPem: string): Promise<CertInfo> {
  ensureDir();
  const tmpCert = path.join(CERT_DIR, 'fullchain.new');
  const tmpKey = path.join(CERT_DIR, 'key.new');
  writeFileSync(tmpCert, certPem, 'utf8');
  writeFileSync(tmpKey, keyPem, 'utf8');
  try {
    return await commitAndReload(tmpCert, tmpKey);
  } finally {
    rmSafe(tmpCert);
    rmSafe(tmpKey);
  }
}

export async function applyP12(p12: Buffer, password: string): Promise<CertInfo> {
  ensureDir();
  const tmpP12 = path.join(CERT_DIR, 'upload.p12');
  const tmpCert = path.join(CERT_DIR, 'fullchain.new');
  const tmpKey = path.join(CERT_DIR, 'key.new');
  writeFileSync(tmpP12, p12);

  const convert = async (legacy: boolean): Promise<boolean> => {
    const extra = legacy ? ['-legacy'] : [];
    try {
      await execFileAsync(OPENSSL, [
        'pkcs12', '-in', tmpP12, '-nokeys', '-out', tmpCert, '-passin', `pass:${password}`, ...extra,
      ]);
      await execFileAsync(OPENSSL, [
        'pkcs12', '-in', tmpP12, '-nocerts', '-nodes', '-out', tmpKey, '-passin', `pass:${password}`, ...extra,
      ]);
    } catch {
      return false;
    }
    return (
      existsSync(tmpCert) &&
      existsSync(tmpKey) &&
      readFileSync(tmpCert).length > 0 &&
      readFileSync(tmpKey).length > 0
    );
  };

  try {
    let ok = await convert(false);
    if (!ok) ok = await convert(true); // старый .p12 (RC2/3DES) → -legacy
    if (!ok) {
      throw new Error('Не удалось извлечь сертификат/ключ. Неверный пароль или несовместимый .p12.');
    }
    return await commitAndReload(tmpCert, tmpKey);
  } finally {
    rmSafe(tmpP12);
    rmSafe(tmpCert);
    rmSafe(tmpKey);
  }
}

export async function revertToLE(): Promise<CertInfo> {
  writeSnippet("# Auto Let's Encrypt.\n");
  await reloadCaddy();
  return getCertInfo();
}
