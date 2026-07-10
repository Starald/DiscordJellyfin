/**
 * Получение аудио-токена ВКонтакте (через "пароль", как официальные клиенты).
 *
 * ВК отдаёт аудио ТОЛЬКО токенам, полученным password-grant'ом официального
 * клиента — implicit-токены с vkhost.github.io аудио-методы не пускают
 * ("Unknown method passed"). Скрипт логинится как Kate Mobile (при неудаче по
 * аудио — как офиц. приложение ВК) и берёт токен, который реально открывает аудио.
 * Пароль уходит ТОЛЬКО на oauth.vk.com, в чат/на экран не печатается.
 *
 * ВАЖНО: ВК жёстко ограничивает частоту входов по паролю (flood control).
 * Делай не больше одной-двух попыток; при блокировке подожди несколько часов.
 *
 * Запуск:  node scripts/vk-token.mjs     (или  npm run vk-token)
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const V = '5.131';

// Клиенты пробуются по очереди; следующий — только если предыдущий ВОШЁЛ, но не
// дал аудио (чтобы не словить flood control повторными попытками входа).
// id/secret/UA — из проекта vkaudiotoken. UA должен совпадать с клиентом токена.
const CLIENTS = [
  {
    name: 'Kate Mobile',
    id: '2685278',
    secret: 'lxhD8OD7dMsqtXIm5IUY',
    ua: 'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)',
  },
  {
    name: 'VK Official (Android)',
    id: '2274003',
    secret: 'hHbZxrka2uZ6jB1inYsH',
    ua: 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x240)',
  },
];

const rl = createInterface({ input: stdin, output: stdout });

// Скрываем ввод пароля: пока muted=true, ничего не эхо-выводим в терминал.
let muted = false;
const origWrite = rl._writeToOutput?.bind(rl);
rl._writeToOutput = (s) => {
  if (!muted && origWrite) origWrite(s);
};
async function askHidden(prompt) {
  stdout.write(prompt);
  muted = true;
  const answer = await rl.question('');
  muted = false;
  stdout.write('\n');
  return answer.trim();
}

function authUrl(client, login, password, extra = {}) {
  const p = new URLSearchParams({
    grant_type: 'password',
    client_id: client.id,
    client_secret: client.secret,
    username: login,
    password,
    scope: 'all',
    v: V,
    '2fa_supported': '1',
    force_sms: '1',
    ...extra,
  });
  return `https://oauth.vk.com/token?${p.toString()}`;
}

async function getJson(url, ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  return res.json();
}

/** Авторизация одним клиентом (с обработкой 2FA / капчи). Возвращает токен или бросает. */
async function authenticate(client, login, password) {
  let extra = {};
  for (let attempt = 0; attempt < 5; attempt++) {
    const data = await getJson(authUrl(client, login, password, extra), client.ua);
    if (data.access_token) return data.access_token;

    if (data.error === 'need_validation') {
      console.log(`  Нужен код подтверждения (2FA, тип: ${data.validation_type ?? '?'}).`);
      if (data.phone_mask) console.log(`  Код отправлен на ${data.phone_mask}.`);
      const code = (await rl.question('  Введи код из SMS / приложения: ')).trim();
      extra = { ...extra, code };
      continue;
    }
    if (data.error === 'need_captcha') {
      console.log(`  Нужна капча, открой ссылку и введи символы:\n  ${data.captcha_img}`);
      const key = (await rl.question('  Капча: ')).trim();
      extra = { ...extra, captcha_sid: data.captcha_sid, captcha_key: key };
      continue;
    }
    const msg = data.error_description ?? data.error ?? JSON.stringify(data);
    throw new Error(String(msg));
  }
  throw new Error('слишком много попыток');
}

/** Проверяем, что токен реально пускает к аудио (с UA своего клиента). */
async function testAudio(token, ua) {
  const url = `https://api.vk.com/method/audio.search?q=test&count=1&access_token=${token}&v=${V}`;
  const data = await getJson(url, ua);
  if (data.error) throw new Error(`${data.error.error_code}: ${data.error.error_msg}`);
  return data.response?.count ?? 0;
}

function writeEnv(key, value) {
  const envPath = path.join(process.cwd(), '.env');
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, `${key}=${value}`);
  else {
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
  }
  writeFileSync(envPath, text, 'utf8');
}

try {
  console.log('=== Получение аудио-токена ВКонтакте ===');
  console.log('Логин/пароль уходят только на oauth.vk.com. Пароль при вводе не отображается.\n');
  const login = (await rl.question('Логин ВК (телефон или email): ')).trim();
  const password = await askHidden('Пароль ВК (ввод скрыт): ');

  let ok = false;
  for (const client of CLIENTS) {
    console.log(`\nПробую клиент: ${client.name}…`);
    let token;
    try {
      token = await authenticate(client, login, password);
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.log(`  авторизация не прошла: ${msg}`);
      if (/flood/i.test(msg)) {
        console.log('  → ВК временно заблокировал вход по паролю. Подожди несколько часов и запусти снова.');
      } else {
        console.log('  → проверь логин/пароль (или 2FA). Другие клиенты не пробую, чтобы не словить flood control.');
      }
      break; // НЕ долбим следующего клиента при ошибке входа
    }

    try {
      const count = await testAudio(token, client.ua);
      console.log(`  ✓ аудио доступно (audio.search count=${count}) через «${client.name}».`);
      writeEnv('VK_TOKEN', token);
      writeEnv('VK_UA', client.ua);
      console.log('\nГотово! VK_TOKEN и VK_UA записаны в .env.');
      console.log('Пересобери/перезапусти бота — вкладка ВК заработает.');
      ok = true;
      break;
    } catch (e) {
      console.log(`  вошёл, но аудио недоступно (${e?.message ?? e}) — пробую следующий клиент.`);
    }
  }

  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('\nНе удалось:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  rl.close();
}
