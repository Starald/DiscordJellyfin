# Деплой панели на ds.starald.ru (Windows + Caddy)

Подтверждённая схема этой машины: роутер пробрасывает внешний `443` прямо в Jellyfin,
своего реверс-прокси нет. Чтобы на том же `443` жил ещё и `ds.starald.ru`, ставим **Caddy**
(уже установлен, v2.11.x) — он один слушает 80/443 и раздаёт оба домена по имени + авто-TLS.

```
интернет ─► роутер :443/:80 ─► Caddy (этот ПК) ─┬─ starald.ru    → 127.0.0.1:8096 (Jellyfin)
                                                └─ ds.starald.ru → 127.0.0.1:8730 (панель)
```

Факты окружения:
- Публичный IP: `85.236.188.205`  • Jellyfin: `:8096` (http), `:8920` (https) • Панель: `:8730`
- Caddyfile: `deploy/Caddyfile` (проверен `caddy validate` + локальный тест маршрутизации)

---

## Порядок go-live (важна последовательность — чтобы не словить лимиты Let's Encrypt)

### 1. DNS
В DNS-панели домена `starald.ru` добавь запись:
```
ds    A    85.236.188.205
```
Проверка: `nslookup ds.starald.ru` → должен вернуть `85.236.188.205`.

### 2. Прод-настройки `.env`
```
PANEL_ENABLED=true
PANEL_PORT=8730
PANEL_PASSWORD=<свой надёжный пароль>
SESSION_SECRET=<длинная случайная строка>
PANEL_SECURE_COOKIE=true
FFMPEG_PATH=C:\Users\Starald\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe
```
`SESSION_SECRET`:  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
(FFMPEG_PATH нужен, чтобы бот находил ffmpeg, когда работает как служба — у служб нет
пользовательского PATH.)

### 3. Роутер (момент переключения — starald.ru на пару минут переедет на Caddy)
- Проброс `443` → **этот ПК, порт 443** (раньше был на Jellyfin :8920).
- Добавь проброс `80` → этот ПК, порт 80 (нужно Caddy для ACME-проверки и http→https).
- Проброс на `:8920` можно убрать — теперь TLS терминирует Caddy.

### 4. Запуск Caddy (получит сертификаты сразу, т.к. DNS+роутер уже готовы)
```powershell
caddy run --config "D:\programming\DiscordJellyfin\deploy\Caddyfile"
```
В логах появится выдача сертификатов для обоих доменов. Проверь:
`https://starald.ru` (Jellyfin) и `https://ds.starald.ru` (логин панели).

---

## Автозапуск 24/7 (службы Windows через NSSM)

```powershell
winget install NSSM.NSSM

# Бот + панель
nssm install JellyfinDiscordBot "C:\Program Files\nodejs\node.exe" "D:\programming\DiscordJellyfin\dist\index.js"
nssm set JellyfinDiscordBot AppDirectory "D:\programming\DiscordJellyfin"
nssm set JellyfinDiscordBot Start SERVICE_AUTO_START
nssm set JellyfinDiscordBot AppStdout "D:\programming\DiscordJellyfin\bot.log"
nssm set JellyfinDiscordBot AppStderr "D:\programming\DiscordJellyfin\bot.log"
nssm start JellyfinDiscordBot

# Caddy
nssm install Caddy "C:\Users\Starald\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe" run --config "D:\programming\DiscordJellyfin\deploy\Caddyfile"
nssm set Caddy AppDirectory "D:\programming\DiscordJellyfin\deploy"
nssm set Caddy Start SERVICE_AUTO_START
nssm start Caddy
```
Обновление бота после правок кода: `npm run build` → `nssm restart JellyfinDiscordBot`.

---

## Проверка
1. `https://ds.starald.ru` → экран логина → вход по `PANEL_PASSWORD`.
2. `https://starald.ru` → Jellyfin как раньше (теперь через Caddy).
3. В панели: выбрать канал → найти альбом → ▶ → звук в Discord.

## Откат (если что-то пошло не так)
Верни в роутере проброс `443` обратно на `:8920` — `starald.ru` снова пойдёт прямо в
Jellyfin, как сейчас. Caddy и бота можно остановить: `nssm stop Caddy`, `nssm stop JellyfinDiscordBot`.

## Безопасность
- Бот/панель слушают только `127.0.0.1` — наружу лишь через Caddy (TLS).
- Весь API и обложки — под логином (cookie-сессия, rate-limit, timing-safe пароль).
- Jellyfin API-ключ наружу не уходит (обложки через прокси `/art`).
