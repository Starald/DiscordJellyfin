import { config as loadEnv } from 'dotenv';

loadEnv();

export interface AppConfig {
  discord: {
    token: string;
    clientId: string;
    guildId: string;
    /**
     * guild  — команды регистрируются на DISCORD_GUILD_ID (мгновенно, для разработки).
     * global — команды видны на всех серверах бота (появляются до ~1 часа).
     */
    commandScope: 'guild' | 'global';
  };
  jellyfin: {
    /** Базовый URL без слеша на конце (обычно локальный — для стрима). */
    url: string;
    apiKey: string;
    /** Публичный URL Jellyfin (для обложек в Discord — их тянет сам Discord извне). */
    publicUrl?: string;
    /** Только для Фазы 2 (каст из Jellyfin). */
    username?: string;
    password?: string;
  };
  /** Через сколько мс простоя бот покидает голосовой канал. */
  idleTimeoutMs: number;
  /** Веб-панель управления (сайт ds.starald.ru). */
  panel: {
    enabled: boolean;
    port: number;
    username: string;
    /** Пароль для входа. Без него публичная панель не поднимается. */
    password?: string;
    /** Отдельный пароль для раздела «Администрирование» (сертификат/логи). */
    adminPassword?: string;
    /** Секрет для подписи cookie-сессии. Если пуст — генерится при старте. */
    sessionSecret?: string;
    /** secure-флаг cookie. true за TLS (прод). false для теста на http://localhost. */
    secureCookie: boolean;
  };
  /** YouTube (через yt-dlp). */
  youtube: {
    /** Путь к cookies.txt (нужен YouTube для обхода анти-бот проверки). */
    cookiesPath: string;
    /** Прокси для yt-dlp (опционально, напр. socks5://127.0.0.1:1080). */
    proxy?: string;
    /** Ключ YouTube Data API v3 — быстрый поиск (не зависит от IP). Опционально. */
    apiKey?: string;
    /** Браузер для живых куки (firefox/chrome/edge) — всегда свежие, без экспорта. */
    cookiesFromBrowser?: string;
  };
  /** Яндекс.Музыка. */
  yandex: {
    /** OAuth-токен аккаунта (для стрима нужна подписка Плюс). */
    token?: string;
    /** Прокси для API и стрима (если прямой путь до Яндекса не работает). */
    proxy?: string;
  };
  /** ВКонтакте (аудио соцсети, через токен Kate Mobile). */
  vk: {
    /** Пользовательский токен со скоупом audio (получают через Kate Mobile). */
    token?: string;
    /** User-Agent клиента, которым добыт токен (audio API требует совпадения). */
    userAgent?: string;
    /** Прокси для API и стрима (если прямой путь до ВК не работает). */
    proxy?: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Не задана обязательная переменная окружения: ${name}. ` +
        `Скопируй .env.example в .env и заполни значения.`,
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(): AppConfig {
  return {
    discord: {
      token: required('DISCORD_TOKEN'),
      clientId: required('DISCORD_CLIENT_ID'),
      guildId: required('DISCORD_GUILD_ID'),
      commandScope: process.env.COMMAND_SCOPE?.trim() === 'global' ? 'global' : 'guild',
    },
    jellyfin: {
      url: normalizeUrl(required('JELLYFIN_URL')),
      apiKey: required('JELLYFIN_API_KEY'),
      publicUrl: optional('JELLYFIN_PUBLIC_URL') && normalizeUrl(optional('JELLYFIN_PUBLIC_URL')!),
      username: optional('JELLYFIN_USERNAME'),
      password: optional('JELLYFIN_PASSWORD'),
    },
    idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS ?? 300_000),
    panel: {
      enabled: process.env.PANEL_ENABLED?.trim() !== 'false',
      port: Number(process.env.PANEL_PORT ?? 8730),
      username: optional('PANEL_USERNAME') ?? 'admin',
      password: optional('PANEL_PASSWORD'),
      adminPassword: optional('ADMIN_PASSWORD'),
      sessionSecret: optional('SESSION_SECRET'),
      secureCookie: process.env.PANEL_SECURE_COOKIE?.trim() !== 'false',
    },
    youtube: {
      cookiesPath: optional('YT_COOKIES') ?? 'youtube-cookies.txt',
      proxy: optional('YT_PROXY'),
      apiKey: optional('YOUTUBE_API_KEY'),
      cookiesFromBrowser: optional('YT_COOKIES_FROM_BROWSER'),
    },
    yandex: {
      token: optional('YANDEX_MUSIC_TOKEN'),
      // Яндекс геоблочит иностранные выходы (451) — прокси обычно НЕ нужен.
      proxy: optional('YANDEX_PROXY'),
    },
    vk: {
      token: optional('VK_TOKEN'),
      userAgent: optional('VK_UA'),
      // ВК нормально работает через прокси (тот же, что у YouTube).
      proxy: optional('VK_PROXY'),
    },
  };
}
