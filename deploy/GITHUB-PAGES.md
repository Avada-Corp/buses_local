# Публикация на GitHub Pages (PWA + уведомления)

GitHub Pages отдаёт статику по **HTTPS** бесплатно — а HTTPS нужен для того, чтобы
работали три вещи, которых нет на `http://IP`:

1. **service worker** (`sw.js`) — офлайн-режим и установка приложения;
2. **установка на главный экран** — иконка, запуск без адресной строки;
3. **системные уведомления** (`Notification` / `showNotification`) — напоминания о рейсах.

Ссылка для пользователей получается вида `https://<логин>.github.io/<репозиторий>/`.

---

## Что заливать

Только файлы сайта — скраперы и настройки сервера для Pages не нужны:

```
index.html
data.js
stats.js           (настройки статистики; можно не заливать)
manifest.json
sw.js
icons/icon-192.png
icons/icon-512.png
icons/maskable-512.png
icons/apple-touch-icon.png
icons/badge-72.png
.nojekyll          (пустой файл: необязателен, но отключает сборку Jekyll)
```

Автообновление расписания (см. ниже) рассчитано на то, что репозиторий — сама папка
проекта (вариант 3): скрипт пушит `data.js` прямо из неё, для этого в репозитории
нужны `_tools/*.js`, `_tools/update-local.ps1` и `_tools/register-task.ps1`.
Если публикуете только файлы сайта (варианты 1–2), `data.js` обновляйте вручную.

Все пути в них относительные, поэтому сайт работает и в корне домена, и в подпапке
(`/berezovka-buses/`), и позже на своём домене.

## Вариант 1. Через сайт GitHub (5 минут, без git)

1. GitHub → **New repository** → имя латиницей (например `berezovka-buses`) →
   **Public** → *Create repository*.
   Бесплатный Pages работает только в публичных репозиториях (страница и так публичная).
2. **Add file → Upload files**: перетащите `index.html`, `data.js`, `stats.js`,
   `manifest.json`, `sw.js` и папку `icons`.
3. **Settings → Pages** → *Source*: **Deploy from a branch** → *Branch*: `main`,
   папка `/ (root)` → **Save**.
4. Через 1–2 минуты страница будет здесь: `https://<логин>.github.io/berezovka-buses/`

## Вариант 2. Через git / GitHub CLI

В проекте не стоит git-репозиторий, а тащить в публичный репозиторий `_tools/`
и `deploy/` не нужно — соберём отдельную папку только с сайтом.

```powershell
$site = "$env:USERPROFILE\berezovka-site"
$src  = "E:\projects\berezovka\buses"

New-Item -ItemType Directory -Force $site | Out-Null
Copy-Item "$src\index.html", "$src\data.js", "$src\stats.js", "$src\manifest.json", "$src\sw.js" $site
Copy-Item "$src\icons" $site -Recurse -Force
New-Item -ItemType File -Force "$site\.nojekyll" | Out-Null

cd $site
git init
git add .
git commit -m "сайт расписания + PWA"
gh auth login                       # если ещё не авторизованы
gh repo create berezovka-buses --public --source=. --push
```

Включить Pages (один раз) — проще в браузере: *Settings → Pages → Deploy from a branch →
`main` / root → Save*. Либо из консоли:

```powershell
gh api -X POST repos/:owner/:repo/pages -f "source[branch]=main" -f "source[path]=/"
```

## Вариант 3. Прямо из папки проекта

Если не хочется держать две папки, версионировать можно сам проект: `.gitignore`
уже настроен так, что в репозиторий не попадают сырые данные сбора (`_tools/live/`),
скриншоты `_tools/*.png`, старая цепочка `fload*` и `*.py`, архив `deploy/berezovka-site.zip`
и мусор ОС. Файлы сайта (`index.html`, `data.js`, `manifest.json`, `sw.js`, `icons/`,
`.nojekyll`) коммитятся, поэтому Pages можно отдавать прямо из корня.

```powershell
cd E:\projects\berezovka\buses
git init
git add .
git commit -m "расписание + PWA"
gh repo create berezovka-buses --public --source=. --push
```

Pages: *Settings → Pages → Deploy from a branch → `main` / root*.

Что вместе с сайтом станет публичным: `_tools/*.js` (сборщик расписания), `deploy/`
(конфиги nginx/systemd и эта инструкция) и `README.md`. Секретов там нет, но если это
лишнее — вариант 2 с отдельной папкой.

## Обновление расписания

Меняется только `data.js`; страницу и service worker трогать не нужно
(они обновляются сами — стратегия network-first).

```powershell
node _tools\scrape_ticketbus.js
node _tools\build_live_data.js
node _tools\check_data.js
node _tools\check_pwa.js            # необязательно: локальная проверка PWA

Copy-Item data.js "$env:USERPROFILE\berezovka-site\data.js"
cd "$env:USERPROFILE\berezovka-site"
git add data.js; git commit -m "расписание"; git push
```

Если репозиторий — сама папка проекта (вариант 3), то вместо `Copy-Item`:

```powershell
cd E:\projects\berezovka\buses
git add data.js; git commit -m "расписание"; git push
```

Если пользуетесь веб-интерфейсом: откройте `data.js` в репозитории →
карандаш → вставьте новое содержимое → *Commit changes*.
GitHub CDN кэширует файлы ~10 минут, так что свежие данные появятся в течение
этого времени.

## Автообновление расписания (планировщик Windows)

GitHub Actions для этого не подходит: `ticketbus.by` (134.17.94.194) отвечает только
белорусским адресам. С раннеров GitHub (Azure, США/ЕС) и ещё из 13 проверенных стран —
таймаут соединения, поэтому job падал на первом же шаге. Автообновление перенесено
на компьютер с белорусским интернетом.

Один раз на этом компьютере:

```powershell
cd E:\projects\berezovka\buses
git pull
powershell -ExecutionPolicy Bypass -File _tools\register-task.ps1
# другое время запуска:
powershell -ExecutionPolicy Bypass -File _tools\register-task.ps1 -At "07:30"
```

Что делает задача `BusesScheduleUpdate` (ежедневно, по умолчанию в 09:00):

1. `git pull --ff-only` — если в проекте нет незакоммиченных изменений;
2. `node _tools/scrape_ticketbus.js` — до 3 попыток с паузой 60 секунд (междугородное
   табло, схемы остановок и пригородная таблица `fload.php`);
3. `node _tools/build_live_data.js` — новый `data.js`;
4. `node _tools/check_data.js` — при ошибке пуш не выполняется, старые данные остаются;
5. если расписание реально изменилось (метка времени сбора не в счёт) —
   коммит «расписание: 25.10.2026 09:00» и `git push`; Pages пересобирается сам.

Полезно знать:

- **ПК был выключен** в 09:00 — задача выполнится при следующем включении. Пока ПК
  выключен, на сайте остаются последние загруженные данные.
- **Лог:** `_tools/update-local.log` — время, вывод всех шагов, ошибки.
- **Проверить, не меняя ничего:** `powershell -ExecutionPolicy Bypass -File _tools\update-local.ps1 -DryRun`
  (собранный файл сохраняется в `_tools/live/data.js` для просмотра).
- **Обновить сейчас:** двойной щелчок по `_tools\update-local.cmd`.
- **Другое время:** перезапустить `register-task.ps1 -At "HH:mm"` — задача перезапишется.
- **Удалить:** `register-task.ps1 -Remove`.
- **Перенесли проект в другую папку** — перерегистрируйте задачу: в ней записан полный путь.
- **`git push` без пароля** работает через Git Credential Manager (уже настроен), задача
  запускается от вашего пользователя. Если Windows когда-нибудь запросит пароль/токен —
  запустите `update-local.cmd` вручную один раз, дальше будет работать само.
- **Нужны `_tools/` в репозитории**: варианты 1–2 (только файлы сайта) автообновление
  не получат — там `data.js` обновляется руками.

## Статистика посещений

GitHub Pages не показывает посещаемость сайта (в Insights — только просмотры
репозитория). Бесплатный и самый простой вариант — **GoatCounter**: без cookie,
поэтому не нужен баннер согласия, скрипт ~2 КБ.

1. Регистрация на [goatcounter.com](https://www.goatcounter.com), код сайта, например
   `berezovka-buses` (адрес дашборда: `https://berezovka-buses.goatcounter.com`).
2. В `stats.js`:

   ```js
   window.STATS = { goatcounter: "berezovka-buses", yandex: 0 };
   ```

3. Закоммитить `stats.js` — и всё. Через пару минут появятся цифры.

Что видно: просмотры и уникальные посетители по дням, источники переходов, города,
устройства и браузеры, а также событие `install` — сколько раз приложение поставили.

Можно вместо него (или вместе) подключить **Яндекс.Метрику**: впишите номер счётчика
в поле `yandex`. Она подробнее (география, карта кликов, «Вебвизор»), но ставит cookie —
в ЕС это требует баннера согласия, поэтому по умолчанию выключена.

Пока оба поля пустые, страница не делает ни одного запроса на сторонние домены.

---

## Проверка, что PWA работает

На компьютере откройте опубликованный адрес и загляните в DevTools:

- **Application → Manifest** — имя, иконки, `display: standalone`, без ошибок;
- **Application → Service Workers** — статус `activated`;
- **Network → Offline → F5** — страница и расписание должны открыться;
- иконка «Установить» в адресной строке Chrome.

Или одной командой локально (нужен Chrome и python):

```powershell
node _tools\check_pwa.js
```

### Телефон, Android

Открыть адрес в Chrome → меню ⋮ → **Установить приложение** (или «Добавить на главный
экран»). Запускать с иконки — откроется без адресной строки.

Уведомления: колокольчик → включить → разрешить. На Android они показываются через
service worker (`showNotification`), поэтому работают и когда приложение свёрнуто.

### iPhone / iPad

Safari → «Поделиться» → **На экран «Домой»**. Баннера установки там нет — это нормально.

Уведомления на iOS доступны **только в установленном** приложении и только с iOS 16.4+.

---

## Ограничения, о которых стоит знать

- **Напоминания работают, пока приложение открыто** (вкладка или свёрнутый PWA).
  Таймер живёт в JS страницы: если приложение выгружено из памяти, будить его некому.
  Настоящие push-уведомления при закрытом приложении требуют сервера (Web Push + VAPID,
  например Cloudflare Worker с cron) — это отдельная задача, GitHub Pages её не решает.
- **Репозиторий публичный.** `data.js` видны всем — впрочем, они и так публичны.
  Если нужен приватный репозиторий, Pages доступен на платном плане; бесплатная
  альтернатива — Cloudflare Pages с приватным репозиторием.
- **Свои HTTP-заголовки задать нельзя.** Кэш ассетов ~10 минут; текущей схеме
  (network-first для страницы и данных) это не мешает.
- Лимиты Pages: 1 ГБ на репозиторий, ~100 ГБ трафика в месяц. Здесь ~150 КБ.
- Свой домен подключается позже: *Settings → Pages → Custom domain*. Пути относительные,
  поэтому ничего переделывать не нужно.
- На `http://IP` (старый способ из `deploy/README.md`) всё продолжает работать как
  обычная страница: регистрация service worker просто не выполняется.
