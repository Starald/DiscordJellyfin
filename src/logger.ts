type Level = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveThreshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return levelOrder[configured] ?? levelOrder.info;
}

const threshold = resolveThreshold();

// Кольцевой буфер последних строк — для просмотра логов в веб-панели (/logs.html).
const BUFFER_SIZE = 1000;
const buffer: string[] = [];

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function emit(level: Level, args: unknown[]): void {
  if (levelOrder[level] < threshold) return;
  const line =
    `[${new Date().toISOString()}] [${level.toUpperCase()}] ` + args.map(formatArg).join(' ');

  buffer.push(line);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
}

export const logger = {
  debug: (...args: unknown[]): void => emit('debug', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),
};

/** Последние строки лога (для веб-панели). */
export function getRecentLogs(limit = 500): string[] {
  return limit >= buffer.length ? buffer.slice() : buffer.slice(-limit);
}
