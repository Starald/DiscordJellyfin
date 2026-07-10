' Копия скрипта автозапуска (активная копия лежит в папке «Автозагрузка» пользователя:
'   %AppData%\Microsoft\Windows\Start Menu\Programs\Startup\jellyfin-discord-bot.vbs )
' Запускает бот+панель и Caddy скрыто при входе пользователя.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\programming\DiscordJellyfin"
sh.Run """C:\Program Files\nodejs\node.exe"" dist\index.js", 0, False
sh.Run """C:\Users\Starald\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe"" run --config ""D:\programming\DiscordJellyfin\deploy\Caddyfile""", 0, False
