(function () {
    "use strict";

    var SCH = window.SCHEDULE || {};
    var DATA = SCH.trips || [];
    var STATIONS = SCH.stations || [];
    var ADDR = SCH.addr || [];
    var CITIES = SCH.cities || [];
    var UPDATED = SCH.updated || "";

    var DAY_NAMES = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
    var DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];   // index 0 = Monday
    var STORE = "berezovka.v2";
    var LIMIT = 8;

    /* ---------- PWA: service worker ---------- */
    // Кэш и установка на главный экран работают только в защищённом контексте
    // (https:// или localhost). На http://IP страница остаётся обычной страницей.
    var SW_READY = null;
    (function registerSW() {
        if (!("serviceWorker" in navigator)) return;
        var host = location.hostname;
        var secure = location.protocol === "https:" ||
            host === "localhost" || host === "127.0.0.1" || host === "[::1]";
        if (!secure) return;
        SW_READY = navigator.serviceWorker.register("./sw.js").catch(function () {
            return null;   // например, старый браузер или запрет приватного режима
        });
    })();

    var state = {
        dir: "out",
        day: "auto",      // "auto" | 0..6 (Monday based)
        place: "all",     // "all" | название крупного пункта (как в данных)
        allDay: false,
        showPast: false,
        openKey: "",      // у какой карточки раскрыты остановки
        notify: {         // напоминания о ближайших рейсах
            on: false,
            count: 2,     // сколько ближайших показывать
            lead: 0,      // за сколько минут напомнить (0 — в момент отправления)
            byPlace: false
        }
    };

    /* ---------- storage ---------- */

    var SYSTEM_LIGHT = !!(window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches);

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        document.querySelector('meta[name="theme-color"]')
            .setAttribute("content", theme === "light" ? "#f4f6f5" : "#0b0f12");
    }

    function initTheme() {
        var saved = "";
        try { saved = localStorage.getItem(STORE + ".theme") || ""; } catch (e) { }
        applyTheme(saved === "light" || saved === "dark" ? saved
            : (SYSTEM_LIGHT ? "light" : "dark"));
    }

    function loadPrefs() {
        try {
            var raw = localStorage.getItem(STORE) || localStorage.getItem("berezovka.v1");
            if (!raw) return;
            var saved = JSON.parse(raw);
            if (saved.dir === "out" || saved.dir === "in") state.dir = saved.dir;
            if (typeof saved.place === "string" && saved.place) state.place = saved.place;
            if (typeof saved.allDay === "boolean") state.allDay = saved.allDay;
            if (saved.notify && typeof saved.notify === "object") {
                if (typeof saved.notify.on === "boolean") state.notify.on = saved.notify.on;
                if ([1, 2, 3].indexOf(saved.notify.count) >= 0) state.notify.count = saved.notify.count;
                if ([0, 5, 10, 15].indexOf(saved.notify.lead) >= 0) state.notify.lead = saved.notify.lead;
                if (typeof saved.notify.byPlace === "boolean") state.notify.byPlace = saved.notify.byPlace;
            }
        } catch (e) { /* приватный режим — работаем без настроек */ }
    }

    function savePrefs() {
        try {
            localStorage.setItem(STORE, JSON.stringify({
                dir: state.dir,
                place: state.place,
                allDay: state.allDay,
                notify: state.notify
            }));
            localStorage.setItem(STORE + ".theme",
                document.documentElement.getAttribute("data-theme") || "");
        } catch (e) { }
    }

    /* ---------- helpers ---------- */

    function nowDay() { return (new Date().getDay() + 6) % 7; }   // 0 = Пн
    function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
    function nowStamp() { var d = new Date(); return d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes(); }

    function toMin(t) {
        if (!t || String(t).indexOf(":") < 0) return null;
        var p = String(t).split(":");
        return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
    }

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    // «МИНСК» -> «Минск», «ЮгоЗападная» -> «Юго Западная»
    function titleCase(s) {
        var v = String(s || "").replace(/([а-яё])([А-ЯЁ])/g, "$1 $2");
        return v.split(/\s+/).map(function (w) {
            return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : "";
        }).join(" ");
    }

    // название остановки для карточки: «ЛИДА АВ» -> «Лида»,
    // «МИНСК АС ЮгоЗападная» -> «Минск (Юго Западная)», «ЕДКИ ПОВ» -> «Едки Пов»
    // (\b в JS работает только с латиницей, поэтому «ЗАЕЗД» проверяем через (\s|$))
    function placeLabel(name) {
        var raw = String(name || "").trim();
        if (/^ЗАЕЗД(\s|$)/i.test(raw)) {
            var parts = raw.split(/[\s-]+/);
            return titleCase(parts[parts.length - 1] || raw) + " (заезд)";
        }
        var m = raw.match(/^(.*?)\s(АС|АВ|АК)(?:\s+(.*))?$/);
        if (m) return titleCase(m[1]) + (m[3] ? " (" + titleCase(m[3]) + ")" : "");
        return titleCase(raw);
    }

    function stationName(i) { return STATIONS[i] || "—"; }
    function cityName(i) { return i >= 0 && CITIES[i] ? titleCase(CITIES[i]) : ""; }

    // «БЕРЁЗОВКА АК» — наша станция (в источнике бывает и без «ё»)
    function isStation(s) { return /^БЕР[ЁЕ]ЗОВКА(\s|$)/.test(String(s || "")); }

    function runsToday(trip, dayIdx) {
        return trip.w.indexOf(dayIdx) >= 0;
    }

    function selectedCity() {
        return state.place === "all" ? -1 : CITIES.indexOf(state.place);
    }

    // индекс остановки Берёзовки на этом рейсе
    function hereIdx(trip) {
        for (var i = 0; i < trip.s.length; i++) {
            if (isStation(STATIONS[trip.s[i][0]])) return i;
        }
        return -1;
    }

    // индекс выбранного пункта на этом рейсе по ходу движения,
    // -1 если рейс через него не идёт: из Берёзовки пункт должен быть дальше,
    // в Берёзовку — раньше (рейс должен оттуда ехать, а не туда)
    function reachStop(trip, cityIdx) {
        if (cityIdx < 0) return -1;
        var here = hereIdx(trip), i, idx;
        if (here < 0) return -1;
        for (i = 0; i < trip.rc.length; i++) {
            if (trip.rc[i][0] !== cityIdx) continue;
            idx = trip.rc[i][1];
            if (trip.d === "out" ? idx > here : idx < here) return idx;
        }
        return -1;
    }

    // пункты, до которых (из Берёзовки) или откуда (в Берёзовку) ходят рейсы
    function cityList() {
        var seen = {}, out = [], i, j, t, here, idx, c;
        for (i = 0; i < DATA.length; i++) {
            t = DATA[i];
            if (t.d !== state.dir) continue;
            here = hereIdx(t);
            if (here < 0) continue;
            for (j = 0; j < t.rc.length; j++) {
                idx = t.rc[j][1];
                if (t.d === "out" ? idx <= here : idx >= here) continue;
                c = t.rc[j][0];
                if (!seen[c]) { seen[c] = 1; out.push(CITIES[c]); }
            }
        }
        return out;
    }

    function inPlace(trip) {
        var sel = selectedCity();
        return sel < 0 || reachStop(trip, sel) >= 0;
    }

    function placeNote() {
        return state.place === "all" ? "" : " по пункту «" + titleCase(state.place) + "»";
    }

    // время выбранной остановки: из Берёзовки — прибытие, в Берёзовку — отправление
    function stopTime(trip, i) {
        var st = trip.s[i];
        if (!st) return "";
        return trip.d === "out" ? (st[3] || st[2]) : (st[2] || st[3]);
    }

    // основное время рейса — отправление из пункта: по нему сортируем, показываем
    // «через N мин» и отбираем прошедшие рейсы; прибытие — вспомогательное
    function depTime(trip, sel) {
        if (trip.d !== "in") return trip.t;      // из Берёзовки — отправление с Берёзовки
        if (sel >= 0) {                          // в Берёзовку — из выбранного пункта
            var si = reachStop(trip, sel);
            return si >= 0 ? stopTime(trip, si) : "";
        }
        return trip.a;                           // ...или из начала маршрута
    }

    // вспомогательное время — прибытие в пункт назначения этого направления
    function arrTime(trip, sel) {
        if (trip.d === "in") return trip.t;      // прибытие в Берёзовку
        if (sel >= 0) {                          // из Берёзовки — прибытие в выбранный пункт
            var si = reachStop(trip, sel);
            return si >= 0 ? (trip.s[si][3] || trip.s[si][2]) : "";
        }
        return trip.a;                           // ...или на конечную маршрута
    }

    // индекс города конечной остановки маршрута (-1 — конечная не крупный пункт)
    function terminusCity(trip) {
        var last = trip.s.length - 1;
        for (var i = 0; i < trip.rc.length; i++) {
            if (trip.rc[i][1] === last) return trip.rc[i][0];
        }
        return -1;
    }

    // переход через сутки: прибытие раньше отправления
    function crossed(trip, dep, arr) {
        var a = toMin(arr), b = toMin(dep);
        if (a === null || b === null) return false;
        return a < b;
    }

    function byTime(a, b) {
        var sel = selectedCity();
        return (toMin(depTime(a, sel)) || 0) - (toMin(depTime(b, sel)) || 0);
    }

    function pastCount(list) {
        var n = nowMin(), sel = selectedCity(), k = 0;
        for (var i = 0; i < list.length; i++) {
            var m = toMin(depTime(list[i], sel));
            if (m !== null && m < n) k++;
        }
        return k;
    }

    function plural(n, one, few, many) {
        var m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
        return many;
    }

    /* ---------- markup ---------- */

    function chipFor(rel) {
        if (rel === null || rel < 0) return "";
        if (rel === 0) return '<span class="chip now">сейчас</span>';
        if (rel <= 15) return '<span class="chip now">через ' + rel + ' мин</span>';
        if (rel <= 60) return '<span class="chip soon">через ' + rel + ' мин</span>';
        return '<span class="chip">через ' + Math.round(rel / 60) + ' ч</span>';
    }

    function agoText(rel) {
        var m = -rel;
        if (m < 60) return m + " мин назад";
        var h = Math.floor(m / 60);
        return h + " " + plural(h, "час", "часа", "часов") + " назад";
    }

    function tripKey(trip) {
        return trip.d + "|" + trip.t + "|" + trip.r + "|" + stationName(trip.p);
    }

    // все остановки рейса: показывается по нажатию на карточку
    function detailsHTML(trip) {
        var sel = selectedCity();
        var selStop = sel >= 0 ? reachStop(trip, sel) : -1;
        var rows = "";
        for (var i = 0; i < trip.s.length; i++) {
            var st = trip.s[i];
            var cls = "stop";
            if (i === trip.at) cls += " here";
            if (i === selStop) cls += " sel";
            rows += '<div class="' + cls + '">' +
                '<span class="s-n">' + esc(stationName(st[0])) + '</span>' +
                '<span class="s-km">' + (st[1] ? st[1] + " км" : "") + '</span>' +
                '<span class="s-t">' + esc(st[2] || st[3] || "—") + '</span>' +
                '</div>';
        }
        return '<div class="details" hidden>' +
            '<div class="d-full">' + esc(trip.r) + '</div>' +
            '<div class="d-days">Дни в источнике: ' + esc(trip.dr || trip.dl) + '</div>' +
            (trip.note ? '<div class="d-days">' + esc(trip.note) + '</div>' : "") +
            '<div class="stops"><div class="stop head">' +
            '<span class="s-n">Остановка</span><span class="s-km">Км</span><span class="s-t">Время</span>' +
            '</div>' + rows + '</div>' +
            '<div class="d-src">источник: ticketbus.by</div>' +
            '</div>';
    }

    function tripHTML(trip, rel, idx, dayNote) {
        var sel = selectedCity();
        var via = false, label;

        if (sel < 0) {
            label = placeLabel(stationName(trip.p));
        } else {
            label = cityName(sel);
            // «сквозной»: из Берёзовки — рейс идёт дальше выбранного пункта,
            // в Берёзовку — рейс идёт дальше самой Берёзовки (к конечной маршрута)
            via = trip.d === "out"
                ? trip.pc !== sel
                : trip.at < trip.s.length - 1;
        }

        var dep = depTime(trip, sel);
        var arr = arrTime(trip, sel);

        var meta = [];
        if (trip.dl) meta.push('<span>' + esc(trip.dl) + '</span>');
        if (dayNote) meta.push('<span class="dow">' + esc(dayNote) + '</span>');
        if (via) {
            // «далее до» — всегда конечная остановка маршрута, а не пункт отправления
            var tci = terminusCity(trip);
            var tname = stationName(trip.s[trip.s.length - 1][0]);
            meta.push('<span class="via">далее до ' +
                esc(tci >= 0 ? cityName(tci) : placeLabel(tname)) + '</span>');
        }
        if (crossed(trip, dep, arr)) {
            meta.push('<span>на следующие сутки</span>');
        }

        var isPast = rel !== null && rel < 0;
        var side = isPast ? '<span class="ago">' + agoText(rel) + '</span>' : chipFor(rel);
        side += '<span class="arr">' + (arr
            ? "приб. " + esc(arr)
            : "время не указано") + '</span>';

        var imminent = rel !== null && rel >= 0 && rel <= 60;
        var cls = "trip" + (isPast ? " is-past" : "");

        return '<li class="' + cls + '" style="--d:' + Math.min(idx, 10) * 18 + 'ms"' +
            ' data-expandable data-key="' + esc(tripKey(trip)) + '"' +
            ' role="button" tabindex="0" aria-expanded="false"' +
            (imminent ? ' data-imminent' : '') + '>' +
            '<div class="time">' + esc(dep) + '</div>' +
            '<div class="to">' +
            '<div class="place" title="' + esc(trip.r) + '">' +
            '<span class="p-name">' + (trip.d === "out" ? "→ " : "← ") + esc(label) + '</span>' +
            (via ? '<span class="tag">сквозной</span>' : '') +
            '<span class="caret" aria-hidden="true"></span></div>' +
            '<div class="meta">' + meta.join("") + '</div>' +
            '</div>' +
            '<div class="side">' + side + '</div>' +
            detailsHTML(trip) +
            '</li>';
    }

    function listHTML(items, now) {
        var sel = selectedCity();
        var html = '<ul class="list">';
        items.forEach(function (t, i) {
            var rel = now === null ? null : toMin(depTime(t, sel)) - now;
            html += tripHTML(t, rel, i);
        });
        return html + '</ul>';
    }

    /* ---------- render ---------- */

    var listEl = document.getElementById("list");
    var noticeEl = document.getElementById("notice");

    function renderDays() {
        var box = document.getElementById("days");
        var today = nowDay();
        var html = '<button type="button" data-day="auto" aria-pressed="' +
            (state.day === "auto") + '" title="Ближайшие рейсы на сегодня" ' +
            (state.day === "auto" ? 'class="today"' : '') + '>Сегодня</button>';
        for (var i = 0; i < 7; i++) {
            html += '<button type="button" data-day="' + i + '" aria-pressed="' +
                (state.day === i) + '" title="' + DAY_NAMES[(i + 1) % 7] + '"' +
                (i === today ? ' class="today"' : '') + '>' + DAY_SHORT[i] + '</button>';
        }
        box.innerHTML = html;
    }

    function setDir(dir) {
        state.dir = dir;
        savePrefs();
        renderPlaces();   // список пунктов зависит от направления
        var btns = document.querySelectorAll(".dir button");
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute("aria-pressed", String(btns[i].dataset.dir === dir));
        }
        render();
    }

    // ---------- выпадающий список пунктов ----------

    function placeText(v) { return v === "all" ? "Все пункты" : titleCase(v); }

    function placeRow(value, text) {
        return '<li role="option" data-value="' + esc(value) + '" aria-selected="' +
            (value === state.place ? "true" : "false") + '">' + esc(text) +
            '<span class="tick" aria-hidden="true">✓</span></li>';
    }

    function renderPlaces() {
        var cities = cityList();
        if (state.place !== "all" && cities.indexOf(state.place) < 0) state.place = "all";
        var html = placeRow("all", "Все пункты");
        cities.sort(function (a, b) { return a.localeCompare(b, "ru"); })
            .forEach(function (c) { html += placeRow(c, titleCase(c)); });
        document.getElementById("placeList").innerHTML = html;
        document.getElementById("placeBtnLabel").textContent = placeText(state.place);
    }

    function placeItems() {
        return document.getElementById("placeList").querySelectorAll("li[data-value]");
    }

    function setActivePlace(li) {
        var items = placeItems();
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle("active", items[i] === li);
        }
    }

    function openPlaces(open) {
        var list = document.getElementById("placeList");
        list.hidden = !open;
        document.getElementById("placeBtn").setAttribute("aria-expanded", String(!!open));
        document.getElementById("placePicker").classList.toggle("open", !!open);
        if (!open) return;
        var cur = list.querySelector('li[aria-selected="true"]') || list.firstElementChild;
        setActivePlace(cur);
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
    }

    function moveActivePlace(step) {
        var items = placeItems();
        if (!items.length) return;
        var at = 0, i;
        for (i = 0; i < items.length; i++) if (items[i].classList.contains("active")) { at = i; break; }
        var next = (at + step + items.length) % items.length;
        setActivePlace(items[next]);
        if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    }

    function setPlace(value) {
        state.place = value || "all";
        savePrefs();
        renderPlaces();
        openPlaces(false);
        render();
    }

    function renderList() {
        var d = new Date();
        document.getElementById("clock").textContent =
            ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
        document.getElementById("todayLabel").textContent = DAY_NAMES[d.getDay()];

        var todayIdx = nowDay();
        var dayIdx = state.day === "auto" ? todayIdx : state.day;
        var isToday = dayIdx === todayIdx;
        var now = nowMin();

        document.getElementById("allDay").checked = state.allDay;
        document.getElementById("showPast").checked = state.showPast;

        var all = DATA.filter(function (t) {
            return t.d === state.dir && inPlace(t) && runsToday(t, dayIdx);
        }).sort(byTime);

        var past = isToday ? pastCount(all) : 0;
        var upcoming = all.length - past;
        var trips, hidden = 0, notice = "";

        if (!isToday || state.allDay || state.showPast) {
            trips = all;
        } else if (upcoming > 0) {
            trips = all.slice(past, past + LIMIT);
            hidden = upcoming - trips.length;
        } else {
            trips = [];
        }

        // сегодня всё уехало — подсказываем ближайшие рейсы завтрашнего дня
        if (isToday && !state.allDay && !state.showPast && !upcoming) {
            var nextDay = (dayIdx + 1) % 7;
            var next = DATA.filter(function (t) {
                return t.d === state.dir && inPlace(t) && runsToday(t, nextDay);
            }).sort(byTime).slice(0, 4);
            if (!next.length) {
                noticeEl.innerHTML = info("На сегодня и завтра рейсов" + placeNote() + " нет.");
                listEl.innerHTML = "";
            } else {
                noticeEl.innerHTML = info("На сегодня рейсов" + placeNote() +
                    " больше нет. Ближайшие — завтра, " + depTime(next[0], selectedCity()) + ".");
                listEl.innerHTML = '<div class="group">Завтра · ' + DAY_SHORT[nextDay] + '</div>' +
                    listHTML(next, null);
            }
            return;
        }

        if (isToday && !state.allDay && !state.showPast && past) {
            notice = "Сегодня уже прошло " + past + " " +
                plural(past, "рейс", "рейса", "рейсов") + placeNote() + ".";
        }
        noticeEl.innerHTML = notice ? info(notice) : "";

        if (!trips.length) {
            listEl.innerHTML = emptyHTML();
            return;
        }

        var html = listHTML(trips, isToday ? now : null);

        if (hidden > 0) {
            html += '<button class="more" type="button" id="moreBtn">Показать весь день — ещё ' +
                hidden + ' ' + plural(hidden, "рейс", "рейса", "рейсов") + '</button>';
        } else if (isToday && !state.allDay && !state.showPast && past) {
            html += '<button class="more" type="button" id="moreBtn">Показать прошедшие · ' +
                past + '</button>';
        }

        listEl.innerHTML = html;

        var more = document.getElementById("moreBtn");
        if (more) {
            more.addEventListener("click", function () {
                state.allDay = true;
                savePrefs();
                render();
            });
        }

        restoreOpen();
    }

    /* ---------- карточка «остановки рейса» ---------- */

    function setOpen(li, open) {
        li.classList.toggle("open", open);
        li.setAttribute("aria-expanded", String(open));
        var det = li.querySelector(".details");
        if (det) det.hidden = !open;
    }

    function restoreOpen() {
        if (!state.openKey) return;
        var items = listEl.querySelectorAll("li.trip");
        for (var i = 0; i < items.length; i++) {
            if (items[i].dataset.key === state.openKey) {
                setOpen(items[i], true);
                return;
            }
        }
    }

    function toggleTrip(li) {
        var open = !li.classList.contains("open");
        var items = listEl.querySelectorAll("li.trip.open");
        for (var i = 0; i < items.length; i++) setOpen(items[i], false);
        setOpen(li, open);
        state.openKey = open ? li.dataset.key : "";
    }

    function info(text) {
        return '<div class="hint"><span class="i">i</span><span>' + esc(text) + '</span></div>';
    }

    function emptyHTML() {
        return '<div class="empty"><span class="big">🚌</span>' +
            'В направлении «' + esc(dirLabel(state.dir)) + '»' + esc(placeNote()) +
            ' на этот день рейсов нет.<br>' +
            'Попробуйте другой день недели' +
            (state.place === "all" ? '' : ' или пункт') + '.</div>';
    }

    function dataError() {
        return '<div class="empty"><span class="big">⚠️</span>' +
            'Расписание не загрузилось.<br>' +
            'Рядом с <code>index.html</code> должен лежать файл <code>data.js</code>.</div>';
    }

    function dirLabel(dir) {
        return dir === "out" ? "Из Берёзовки" : "В Берёзовку";
    }

    /* ---------- напоминания о ближайших рейсах ---------- */

    // системные уведомления возможны только в secure context (HTTPS / localhost)
    var CAN_NOTIFY = (typeof Notification !== "undefined") && !!window.isSecureContext;

    var BASE_TITLE = document.title;
    var alerted = {};    // что уже просигналили в этой сессии
    var audioCtx = null;

    function notifySel() { return state.notify.byPlace ? selectedCity() : -1; }
    function notifyDep(t) { return depTime(t, notifySel()); }

    // ближайшие рейсы по времени отправления (направление и день — как на странице)
    function nextTrips(n) {
        var todayIdx = nowDay();
        var dayIdx = state.day === "auto" ? todayIdx : state.day;
        var now = nowMin();
        var out = [], dayOffset = 0, guard = 0;
        while (out.length < n && guard < 8) {
            var di = (dayIdx + dayOffset) % 7;
            var isToday = di === todayIdx;
            var list = DATA.filter(function (t) {
                return t.d === state.dir &&
                    (!state.notify.byPlace || inPlace(t)) &&
                    runsToday(t, di);
            }).sort(function (a, b) {
                return (toMin(notifyDep(a)) || 0) - (toMin(notifyDep(b)) || 0);
            });
            for (var i = 0; i < list.length && out.length < n; i++) {
                var m = toMin(notifyDep(list[i]));
                if (m === null) continue;
                if (isToday && m < now) continue;      // рейс уже ушёл
                out.push({ trip: list[i], dep: notifyDep(list[i]), m: m, di: di, away: dayOffset });
            }
            dayOffset++;
            guard++;
        }
        return out;
    }

    function relText(rel) {
        if (rel === null) return "";
        if (rel <= 0) return "сейчас";
        if (rel < 60) return "через " + rel + " мин";
        return "через " + Math.round(rel / 60) + " ч";
    }

    function tripCaption(trip) {
        if (state.notify.byPlace && selectedCity() >= 0) return cityName(selectedCity());
        return placeLabel(stationName(trip.p));
    }

    function renderPinned() {
        var box = document.getElementById("pinned");
        if (!state.notify.on) { box.hidden = true; box.innerHTML = ""; return; }
        var items = nextTrips(state.notify.count);
        if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
        var parts = ['<span class="bell" aria-hidden="true">🔔</span>'];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (i) parts.push('<span class="p-sep">•</span>');
            var when = it.away === 0 ? relText(it.m - nowMin())
                : (it.away === 1 ? "завтра" : DAY_SHORT[it.di]);
            parts.push('<span class="p-item">' +
                '<span class="p-dep">' + esc(it.dep) + '</span>' +
                '<span class="p-to">' + (it.trip.d === "out" ? "→ " : "← ") +
                esc(tripCaption(it.trip)) + '</span>' +
                '<span class="p-rel">' + esc(when) + '</span></span>');
        }
        box.innerHTML = parts.join("");
        box.hidden = false;
    }

    // ближайший рейс в окне «за N минут до отправления»
    function dueTrip() {
        var items = nextTrips(state.notify.count);
        for (var i = 0; i < items.length; i++) {
            if (items[i].away !== 0) continue;
            var rel = items[i].m - nowMin();
            if (rel >= 0 && rel <= state.notify.lead) return items[i];
        }
        return null;
    }

    function flashCard(trip) {
        var key = tripKey(trip), els = listEl.querySelectorAll("li.trip");
        for (var i = 0; i < els.length; i++) {
            if (els[i].dataset.key !== key) continue;
            var el = els[i];
            el.classList.add("flash");
            if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
            setTimeout(function () { el.classList.remove("flash"); }, 2600);
            return;
        }
    }

    // AudioContext должен создаться из жеста пользователя (клик по колокольчику)
    function primeAudio() {
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            if (!audioCtx) audioCtx = new AC();
            if (audioCtx.state === "suspended") audioCtx.resume();
        } catch (e) { }
    }

    function beep() {
        if (!audioCtx) return;
        try {
            if (audioCtx.state === "suspended") audioCtx.resume();
            var o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.type = "sine";
            o.frequency.value = 880;
            var t0 = audioCtx.currentTime;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
            o.connect(g); g.connect(audioCtx.destination);
            o.start(t0); o.stop(t0 + 0.36);
        } catch (e) { }
    }

    // системное уведомление: на Android Chrome конструктор new Notification()
    // не работает, поэтому показываем через service worker, а на десктопе
    // без SW остаётся обычный путь
    function notifyOS(it) {
        if (!CAN_NOTIFY || Notification.permission !== "granted") return;
        var title = "Берёзовка АК · " + dirLabel(it.trip.d);
        var opts = {
            body: it.dep + " " + (it.trip.d === "out" ? "→ " : "← ") +
                tripCaption(it.trip) + " (" + relText(it.m - nowMin()) + ")",
            icon: "icons/icon-192.png",
            badge: "icons/badge-72.png",
            tag: "berezovka-next",
            renotify: true,
            vibrate: [120, 60, 120],
            data: { url: "./" }
        };

        function plain() {
            try { new Notification(title, opts); } catch (e) { }
        }

        if (!SW_READY) { plain(); return; }
        SW_READY.then(function (reg) {
            if (reg && reg.active && reg.showNotification) {
                reg.showNotification(title, opts).catch(plain);
            } else {
                plain();
            }
        }, plain);
    }

    function setTitle(t) { if (document.title !== t) document.title = t; }
    function resetTitle() { if (document.title !== BASE_TITLE) document.title = BASE_TITLE; }

    function tickReminders() {
        if (!state.notify.on) {
            document.getElementById("pinned").hidden = true;
            resetTitle();
            return;
        }
        renderPinned();
        var it = dueTrip();
        if (!it) { resetTitle(); return; }
        var key = tripKey(it.trip) + "@" + it.dep;
        setTitle("🚌 " + it.dep + " — " + relText(it.m - nowMin()));
        if (!alerted[key]) {
            alerted[key] = 1;
            try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) { }
            beep();
            flashCard(it.trip);
            notifyOS(it);
        }
    }

    // список + напоминания
    function render() {
        renderList();
        tickReminders();
    }

    /* ---------- wiring ---------- */

    loadPrefs();
    initTheme();
    renderDays();

    if (!DATA.length) {   // data.js не подключился — сообщаем прямо, без «рейсов нет»
        document.getElementById("list").innerHTML = dataError();
        return;
    }

    renderPlaces();

    if (UPDATED) {
        var stamp = UPDATED.slice(0, 10).split("-");
        if (stamp.length === 3) {
            document.getElementById("srcDate").textContent =
                stamp[2] + "." + stamp[1] + "." + stamp[0];
        }
    }

    var dirBtns = document.querySelectorAll(".dir button");
    for (var i = 0; i < dirBtns.length; i++) {
        dirBtns[i].setAttribute("aria-pressed", String(dirBtns[i].dataset.dir === state.dir));
        dirBtns[i].addEventListener("click", function () { setDir(this.dataset.dir); });
    }

    document.getElementById("days").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-day]");
        if (!b) return;
        state.day = b.dataset.day === "auto" ? "auto" : parseInt(b.dataset.day, 10);
        renderDays();
        render();
    });

    // выпадающий список пунктов: открытие, выбор, клавиатура, закрытие по клику вне
    var placeBtn = document.getElementById("placeBtn");
    var placeListEl = document.getElementById("placeList");

    placeBtn.addEventListener("click", function () {
        openPlaces(placeListEl.hidden);
    });

    placeListEl.addEventListener("click", function (e) {
        var li = e.target.closest("li[data-value]");
        if (li) setPlace(li.getAttribute("data-value"));
    });

    placeListEl.addEventListener("mousemove", function (e) {
        var li = e.target.closest("li[data-value]");
        if (li) setActivePlace(li);
    });

    placeBtn.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { openPlaces(false); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (placeListEl.hidden) openPlaces(true);
            else moveActivePlace(e.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if ((e.key === "Enter" || e.key === " ") && !placeListEl.hidden) {
            e.preventDefault();
            var act = placeListEl.querySelector("li.active") ||
                placeListEl.querySelector('li[aria-selected="true"]');
            if (act) setPlace(act.getAttribute("data-value"));
        }
    });

    document.addEventListener("click", function (e) {
        if (!placeListEl.hidden && !e.target.closest("#placePicker")) openPlaces(false);
    });

    document.getElementById("allDay").addEventListener("change", function () {
        state.allDay = this.checked;
        savePrefs();
        render();
    });

    document.getElementById("showPast").addEventListener("change", function () {
        state.showPast = this.checked;
        render();
    });

    document.getElementById("themeBtn").addEventListener("click", function () {
        var cur = document.documentElement.getAttribute("data-theme");
        applyTheme(cur === "light" ? "dark" : "light");
        savePrefs();
    });

    // напоминания: колокольчик, настройки, закрытие по клику вне/по Escape
    var alertBtn = document.getElementById("alertBtn");
    var notifyPop = document.getElementById("notifyPop");

    function renderNotifyControls() {
        var note = "";
        if (!CAN_NOTIFY) {
            note = "Системные уведомления недоступны без HTTPS — напоминания показываем на странице.";
        } else if (Notification.permission === "denied") {
            note = "Уведомления запрещены в настройках браузера — напоминания показываем на странице.";
        }
        document.getElementById("npNote").textContent = note;
        document.getElementById("npOn").checked = state.notify.on;
        document.getElementById("npByPlace").checked = state.notify.byPlace;
        alertBtn.classList.toggle("on", state.notify.on);
        alertBtn.setAttribute("aria-pressed", String(state.notify.on));
        var cs = notifyPop.querySelectorAll('[data-role="count"] button');
        for (var i = 0; i < cs.length; i++) {
            cs[i].setAttribute("aria-pressed", String(+cs[i].dataset.count === state.notify.count));
        }
        var ls = notifyPop.querySelectorAll('[data-role="lead"] button');
        for (var j = 0; j < ls.length; j++) {
            ls[j].setAttribute("aria-pressed", String(+ls[j].dataset.lead === state.notify.lead));
        }
    }

    function openNotify(open) {
        notifyPop.hidden = !open;
        alertBtn.setAttribute("aria-expanded", String(!!open));
        if (open) renderNotifyControls();
    }

    alertBtn.addEventListener("click", function () {
        primeAudio();
        openNotify(notifyPop.hidden);
    });

    notifyPop.addEventListener("click", function (e) {
        var cb = e.target.closest('[data-role="count"] button');
        if (cb) {
            state.notify.count = parseInt(cb.dataset.count, 10);
            savePrefs();
            renderNotifyControls();
            render();
            return;
        }
        var lb = e.target.closest('[data-role="lead"] button');
        if (lb) {
            state.notify.lead = parseInt(lb.dataset.lead, 10);
            savePrefs();
            renderNotifyControls();
            render();
        }
    });

    document.getElementById("npOn").addEventListener("change", function () {
        state.notify.on = this.checked;
        if (state.notify.on) {
            alerted = {};
            primeAudio();
            if (CAN_NOTIFY && Notification.permission === "default") {
                try {
                    var p = Notification.requestPermission();
                    if (p && p.then) p.then(renderNotifyControls);
                } catch (e) { }
            }
        }
        savePrefs();
        renderNotifyControls();
        render();
    });

    document.getElementById("npByPlace").addEventListener("change", function () {
        state.notify.byPlace = this.checked;
        savePrefs();
        render();
    });

    document.addEventListener("click", function (e) {
        if (!notifyPop.hidden && !e.target.closest("#notifyPop") &&
                !e.target.closest("#alertBtn")) {
            openNotify(false);
        }
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !notifyPop.hidden) openNotify(false);
    });

    // нажатие на карточку раскрывает список остановок рейса
    listEl.addEventListener("click", function (e) {
        var li = e.target.closest("li.trip");
        if (li) toggleTrip(li);
    });

    listEl.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        var li = e.target.closest("li.trip");
        if (!li) return;
        e.preventDefault();
        toggleTrip(li);
    });

    renderNotifyControls();
    render();

    var stamp = nowStamp();
    setInterval(function () {
        var d = new Date();
        document.getElementById("clock").textContent =
            ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
        if (nowStamp() !== stamp) {   // сменилась минута или сутки
            stamp = nowStamp();
            render();
        } else {
            tickReminders();          // обновляем «через N мин» и напоминания
        }
    }, 20000);
})();
