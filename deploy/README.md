# Деплой страницы расписания на сервер

Страница статическая: `index.html`, `data.js`, `manifest.json`, `sw.js` и папка `icons/`
(иконки нужны только для PWA — без них страница тоже работает).
Ни сборки, ни Node, ни базы, ни интернета на сервере не нужно (шрифты системные,
внешних скриптов нет). Поэтому подходит любой способ отдать статику.

Файлы для заливки: `index.html`, `data.js`, `manifest.json`, `sw.js`, `icons/`
(и `README.md` из корня проекта, если нужен).

> **PWA и уведомления требуют HTTPS.** Service worker, установка на главный экран и
> системные уведомления работают только в защищённом контексте. По `http://IP` страница
> открывается как обычная. Бесплатный HTTPS — GitHub Pages, пошагово в
> [GITHUB-PAGES.md](GITHUB-PAGES.md). Для локальной проверки хватает `http://localhost`.

---

## Вариант 1. Совсем просто: python прямо из папки (1 минута)

На сервере (Linux, python3 почти всегда есть). Портом взят **8423** — если он тоже занят,
замените везде на любой свободный (`ss -tlnp | grep <порт>` показывает занятые).

```bash
sudo mkdir -p /var/www/berezovka
# скопировать файлы (с локальной машины):
#   scp index.html data.js manifest.json sw.js user@IP:/var/www/berezovka/
#   scp -r icons user@IP:/var/www/berezovka/

cd /var/www/berezovka
nohup python3 -m http.server 8423 --bind 0.0.0.0 > /tmp/berezovka.log 2>&1 &
```

Открывать: `http://IP:8423/`

Быстрее всё вместе: `deploy\upload.ps1 -Server IP` (копирует и файлы, и `icons/`).

Чтобы не гасло после перезагрузки — см. `berezovka-http.service` (положить в
`/etc/systemd/system/`, затем `systemctl enable --now berezovka-http`).

Минусы: один поток, нет кэширующих заголовков. Для нескольких человек этого достаточно.

## Вариант 2. Nginx (если он уже стоит — лучший вариант)

Положить файлы в `/var/www/berezovka/` и добавить конфиг из `berezovka-nginx.conf`:

- как отдельный сайт по IP: `http://IP/`
- как подпапка существующего сайта: `http://IP/bus/`

```bash
sudo cp deploy/berezovka-nginx.conf /etc/nginx/sites-available/berezovka
sudo ln -s /etc/nginx/sites-available/berezovka /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Вариант 3. Docker (одна строка)

```bash
docker run -d --restart unless-stopped --name berezovka \
  -p 8423:80 -v /var/www/berezovka:/usr/share/nginx/html:ro nginx:alpine
```

Открывать: `http://IP:8423/`

## Вариант 4. Caddy (если уже установлен)

```bash
caddy file-server --root /var/www/berezovka --listen :8423
```

---

## Если не открывается — три обычные причины

1. **Файрвол на сервере**: `sudo ufw allow 8423/tcp` (или `firewall-cmd --add-port=8423/tcp`).
2. **Файрвол у хостера**: в панели (Hetzner/AWS/Selectel/…) порт должен быть разрешён
   в security group / firewall.
3. **Порт занят**: проверить `ss -tlnp | grep 8423` и взять другой свободный.
   Порт 80 обычно занят другим сайтом — тогда берите 8423 или ставьте подпапкой.

## Обновление расписания (раз в сутки-неделю)

Данные в `data.js`, страницу перезаливать не нужно:

```bash
# локально, в папке проекта:
node _tools/scrape_ticketbus.js      # снять свежее табло с ticketbus.by
node _tools/build_live_data.js       # собрать data.js
node _tools/check_data.js            # проверки
# затем залить только data.js:
scp data.js user@IP:/var/www/berezovka/
```

Достаточно заменить `data.js` — страница подхватит новое при обновлении в браузере.
В футере страницы видно дату данных.

Если страница на GitHub Pages, обновление можно автоматизировать: workflow
`.github/workflows/update-schedule.yml` делает то же самое по расписанию
(подробности — [GITHUB-PAGES.md](GITHUB-PAGES.md), раздел «Автообновление расписания»).
Статистика посещений там же, раздел «Статистика посещений».

## Что учесть

- Страница работает и по `http://IP:8423/`, и в подпапке: все пути относительные.
- **По `http://IP` PWA-возможности выключены**: service worker не регистрируется,
  установки на главный экран и системных уведомлений нет (это ограничение браузеров,
  а не страницы). Нужен HTTPS — см. [GITHUB-PAGES.md](GITHUB-PAGES.md).
- `sw.js` и `manifest.json` не стоит кэшировать надолго: в `berezovka-nginx.conf` для них
  уже стоит `no-cache`. Если отдаёте статику чем-то другим, проверьте, что `sw.js`
  отдаётся как `application/javascript`.
- Никаких секретов в файлах нет, авторизация не требуется — кто знает адрес, тот смотрит.
- Настройки пользователя (направление, пункт, тема) хранятся в localStorage браузера,
  то есть привязаны к адресу сайта; при смене адреса выбор сбросится.
