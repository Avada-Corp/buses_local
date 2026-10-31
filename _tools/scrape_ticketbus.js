#!/usr/bin/env node
"use strict";

// Скрейпер расписания станции через API ticketbus.by (без зависимостей).
//
//   node _tools/scrape_ticketbus.js [station_id]
//
// station_id по умолчанию 409012 — «БЕРЕЗОВКА(ЛИДСК.Р-Н)», та же станция,
// что и в сохранённой странице fload.htm.
//
// Что делает:
//   1) GET  /                                  -> берём PHPSESSID из HTML
//   2) POST getdata.php?prog=raspis2&host=1    -> междугородные рейсы через станцию
//   3) POST getdata.php?prog=getstation2       -> схема остановок каждого рейса
//   4) GET  /fload.php?id=<station>&sys=BJ     -> прямые рейсы из Берёзовки
//   5) POST prog=raspis2 для города назначения -> актуальные пригородные рейсы
//   6) пишет _tools/live/board.html, scheme-<код>.html, origin-<id>.html, board.json
//
// Почему так: табло raspis2 НЕ показывает рейсы, которые начинаются в Берёзовке.
// Они есть только на странице табло станции fload.php в двух таблицах:
// t0 — пригородные (Лида), t1 — междугородные (Минск). Причём времена в t0
// устаревают: на 30.10.2026 не было 08:25 и 12:30, а 18:10 указан как 18:30.
// Поэтому для пригородных рейсов времена, дни и схемы остановок берём с табло
// города назначения, а t0/t1 используем как список направлений и как запасной
// источник, если табло города недоступно.
//
// board.json — по одной записи на рейс:
//   { code, route, note, daysRaw, dir, at, t, a, from, to,
//     stops: [{ n, km, dep, arr, addr }], reach: ["..."] }
// и warnings — то, что не удалось прочитать надёжно (см. конец main()).

const https = require("https");
const fs = require("fs");
const path = require("path");

const HOST = "ticketbus.by";
const STATION_ID = process.argv[2] || "409012";
const OUT_DIR = path.join(__dirname, "live");

function request(pathname, body, method) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: pathname,
        method: method || "POST",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; berezovka-buses/1.0)",
          referer: "https://" + HOST + "/",
          "content-type": "application/x-www-form-urlencoded",
          accept: "*/*",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const text = (html) =>
  String(html)
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cellsOf = (rowHtml) =>
  [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));

// Строка доски станции: <tr><td>код</td><td onClick="showclick('...','1','0')">маршрут</td>...
function parseBoard(html) {
  const runs = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const raw = m[1];
    const cells = cellsOf(raw);
    const click = raw.match(/showclick\('([^']+)','(\d)','(\d+)'\)/);
    if (!click || cells.length < 6) continue;
    runs.push({
      code: click[1],
      par: click[2],
      route: cells[1].replace(/\s*\/\s*$/, ""),
      note: (/\/\s*(.+)$/.exec(cells[1]) || [, ""])[1],
      period: cells[2], // «06:10/06:45» — отправление с первой остановки / время на станции
      daysRaw: cells[4],
      geo: cells[5],
    });
  }
  return runs;
}

// Схема рейса: ячейки идут по пять — Станция | Расстояние | Отправление | Прибытие | Адрес
function parseScheme(html) {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
  const stops = [];
  for (let i = 0; i + 4 < cells.length; i += 5) {
    stops.push({
      n: cells[i],
      km: parseFloat(cells[i + 1]) || 0,
      dep: cells[i + 2] || "",
      arr: cells[i + 3] || "",
      addr: cells[i + 4] || "",
    });
  }
  return stops;
}

// В таблицах fload.php кириллическая «Р» заменена латинской «P» (для шрифта
// табло), например «БЕPЕЗОВКА АК-ЛИДА АВ» — возвращаем буквы на место, иначе
// не сработают сравнения, разбор дней и названий.
const fixCyrillic = (s) => String(s || "").replace(/P/g, "Р").replace(/p/g, "р");

// Ячейки строки (разделители — <th>, поэтому в строке 7 <td>):
//   № | маршрут | дни | отпр. с Берёзовки | приб. конечн. | отпр. конечн. | приб. Берёзовка
function parseFloadTable(html, id, note) {
  const re = new RegExp("<table[^>]*id=['\"]" + id + "['\"][^>]*>([\\s\\S]*?)<\\/table>", "i");
  const table = (re.exec(html) || [, ""])[1];
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const runs = [];
  for (const raw of rows) {
    const c = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => fixCyrillic(text(m[1])));
    if (c.length < 7) continue;
    const route = c[1].trim();
    const m = /^БЕР[ЁЕ]ЗОВКА\s*АК\s*-\s*(.+)$/.exec(route);
    if (!m) continue; // только рейсы, которые начинаются на нашей станции
    const t = c[3];
    const a = c[4];
    if (!/^\d{2}:\d{2}$/.test(t) || !/^\d{2}:\d{2}$/.test(a)) continue;
    runs.push({ route, to: m[1].trim(), daysRaw: c[2], t, a, note: note || "" });
  }
  return runs;
}

// t0 — пригородные, t1 — междугородные прямые рейсы из Берёзовки.
const parseSuburban = (html) => parseFloadTable(html, "t0", "");
const parseIntercity = (html) => parseFloadTable(html, "t1", "продажа только в автобусе");

// \b в JS работает только по ASCII, поэтому границу слова проверяем явно
const isStation = (name) => /^БЕР[ЁЕ]ЗОВКА(\s|$)/.test(name);

// «БЕРЕЗОВКА АК-ЛИДА АВ / примечание» -> «БЕРЕЗОВКА АК-ЛИДА АВ»
const routeName = (route) => String(route || "").split(/\s*\/\s*/)[0].trim();

// «ЛИДА АВ» -> «ЛИДА»: в getcity названия без типа станции.
const cityBase = (name) => String(name || "").replace(/\s+(АВ|АК|АС)$/i, "").trim().toUpperCase();

// Название маршрута -> пункт назначения: «БЕРЕЗОВКА АК-ЛИДА АВ» -> «ЛИДА АВ».
function destinationOf(route) {
  const m = /^БЕР[ЁЕ]ЗОВКА\s*АК\s*-\s*(.+)$/i.exec(routeName(route));
  return m ? m[1].trim() : "";
}

// Список городов из формы поиска: <option value='409001' >ЛИДА</option>
async function getCities(api) {
  const html = await request(api + "&prog=getcity", "prog=getcity");
  return [...html.matchAll(/<option value='(\d+)' >([^<]+)<\/option>/g)]
    .map((m) => ({ id: m[1], name: m[2].trim() }));
}

function findCity(cities, name) {
  const want = cityBase(name);
  if (!want) return null;
  return (
    cities.find((c) => cityBase(c.name) === want) ||
    cities.find((c) => cityBase(c.name).indexOf(want + " ") === 0) ||
    cities.find((c) => want.indexOf(cityBase(c.name) + " ") === 0) ||
    null
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const home = await request("/", "");
  const sid = (home.match(/PHPSESSID=([a-z0-9]+)/) || [])[1];
  if (!sid) throw new Error("не удалось получить PHPSESSID");
  const api = "/getdata.php?PHPSESSID=" + sid;

  const boardHtml = await request(
    api + "&prog=raspis2&host=1",
    "station_id=" + STATION_ID + "&station_id1=&path=0"
  );
  fs.writeFileSync(path.join(OUT_DIR, "board.html"), boardHtml, "utf8");

  const board = parseBoard(boardHtml);
  if (!board.length) throw new Error("доска станции пуста — изменился формат ответа");
  console.log("рейсов на доске:", board.length);

  const runs = [];
  const seen = new Set();
  for (const row of board) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    const file = path.join(OUT_DIR, "scheme-" + row.code.replace(/[^\w.~-]/g, "_") + ".html");
    const schemeHtml = await request(api + "&prog=getstation2", "station_id=" + encodeURIComponent(row.code));
    fs.writeFileSync(file, schemeHtml, "utf8");
    const stops = parseScheme(schemeHtml);
    const at = stops.findIndex((s) => isStation(s.n));
    if (at < 0 || !stops.length) {
      console.log("  пропуск (нет остановки станции):", row.route, row.code);
      continue;
    }
    const outbound = at < stops.length - 1;
    const here = stops[at];
    runs.push({
      code: row.code,
      route: row.route,
      note: row.note,
      daysRaw: row.daysRaw,
      dir: outbound ? "out" : "in",
      at, // индекс остановки «БЕРЁЗОВКА АК»
      t: here.dep || here.arr, // время на станции
      a: outbound ? stops[stops.length - 1].arr || stops[stops.length - 1].dep
                  : stops[0].dep || stops[0].arr, // время на конечной
      from: stops[0].n,
      to: stops[stops.length - 1].n,
      stops,
      reach: (outbound ? stops.slice(at + 1) : stops.slice(0, at)).map((s) => s.n),
      period: row.period,
    });
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  // ---------- рейсы, которые начинаются в Берёзовке ----------
  const stopAddr = new Map();
  runs.forEach((r) => r.stops.forEach((s) => {
    if (!stopAddr.has(s.n)) stopAddr.set(s.n, s.addr || "");
  }));
  // Имя остановки берём из данных, а не пишем вручную: на табло «БЕРЕЗОВКА АК»
  // без «Ё», иначе в справочнике появится вторая такая же остановка.
  const hereStop = runs.reduce((acc, r) => acc || r.stops.find((s) => isStation(s.n)), null);
  const hereName = hereStop ? hereStop.n : "БЕРЕЗОВКА АК";

  const suburbanHtml = await request(
    "/fload.php?PHPSESSID=" + sid + "&id=" + STATION_ID + "&sys=BJ",
    null,
    "GET"
  );
  fs.writeFileSync(path.join(OUT_DIR, "suburban.html"), suburbanHtml, "utf8");
  // Без таблицы не узнаем пригородные направления — лучше упасть, чем молча
  // потерять все рейсы, начинающиеся в Берёзовке.
  if (!/id=['"]t0['"]/i.test(suburbanHtml)) {
    throw new Error("в fload.php нет пригородной таблицы — изменился формат ответа");
  }
  const suburban = parseSuburban(suburbanHtml);
  const intercity = parseIntercity(suburbanHtml);
  console.log(
    "прямых рейсов в fload.php: пригородных", suburban.length,
    "| междугородных", intercity.length
  );

  const warnings = [];
  const cities = await getCities(api);
  const origin = [];

  // Строки t0 и t1 — это рейсы, которые начинаются в Берёзовке.
  const sourceRows = [];
  suburban.forEach((s) => sourceRows.push(Object.assign({ src: "t0" }, s)));
  intercity.forEach((s) => sourceRows.push(Object.assign({ src: "t1" }, s)));

  const resolved = new Map(); // пункт назначения -> удалось ли прочитать табло города
  const dests = [];
  for (const s of sourceRows) {
    if (dests.indexOf(s.to) < 0) dests.push(s.to);
  }

  // Версия расписания в коде: «…~20260812» (чем позже, тем новее).
  const codeDate = (code) => {
    const m = /~(\d{8})$/.exec(code || "");
    return m ? Number(m[1]) : 0;
  };

  for (const dest of dests) {
    const city = findCity(cities, dest);
    if (!city) {
      // Например, Минска нет в списке городов поиска — это нормально,
      // для таких направлений времена берём из fload.php.
      console.log("  " + dest + ": табло города недоступно — данные из fload.php");
      resolved.set(dest, false);
      continue;
    }

    const destHtml = await request(
      api + "&prog=raspis2&host=1",
      "station_id=" + city.id + "&station_id1=&path=0"
    );
    fs.writeFileSync(path.join(OUT_DIR, "origin-" + city.id + ".html"), destHtml, "utf8");

    // На табло бывают две версии одного рейса (старая и новая) — берём новейшую.
    const byRouteDep = new Map();
    parseBoard(destHtml)
      .filter((r) => /^БЕР[ЁЕ]ЗОВКА\s*АК/i.test(routeName(r.route)))
      .forEach((row) => {
        const dep = (String(row.period || "").split("/")[0] || "").trim();
        const key = routeName(row.route) + "|" + dep;
        const prev = byRouteDep.get(key);
        if (!prev || codeDate(row.code) > codeDate(prev.code)) byRouteDep.set(key, row);
      });
    const rows = [...byRouteDep.values()];

    if (!rows.length) {
      warnings.push("на табло «" + city.name + "» нет рейсов из Берёзовки");
      resolved.set(dest, false);
      continue;
    }
    resolved.set(dest, true);

    let added = 0;
    for (const row of rows) {
      const period = /^(\d{2}:\d{2})\s*\/\s*(\d{2}:\d{2})/.exec(row.period || "");
      if (!period) {
        warnings.push("непонятное время рейса " + routeName(row.route) + " «" + row.period + "»");
        continue;
      }
      const t = period[1];
      const a = period[2];

      // Схема остановок: по коду с табло города getstation2 работает.
      const schemeHtml = await request(
        api + "&prog=getstation2",
        "station_id=" + encodeURIComponent(row.code)
      );
      fs.writeFileSync(
        path.join(OUT_DIR, "scheme-" + row.code.replace(/[^\w.~-]/g, "_") + ".html"),
        schemeHtml,
        "utf8"
      );
      let stops = parseScheme(schemeHtml);

      if (!stops.length || !isStation(stops[0].n)) {
        warnings.push("нет схемы для " + routeName(row.route) + " " + row.period + " — только две остановки");
        stops = [
          { n: hereName, km: 0, dep: t, arr: "", addr: stopAddr.get(hereName) || "" },
          { n: dest, km: 0, dep: "", arr: a, addr: stopAddr.get(dest) || "" },
        ];
      }

      origin.push({
        code: row.code,
        route: routeName(row.route),
        note: row.note,
        daysRaw: row.daysRaw,
        dir: "out",
        at: 0,
        t: stops[0].dep || t,
        a: stops[stops.length - 1].arr || stops[stops.length - 1].dep || a,
        from: stops[0].n,
        to: stops[stops.length - 1].n,
        stops,
        reach: stops.slice(1).map((s) => s.n),
        period: row.period,
      });
      added++;
    }
    console.log("  " + city.name + ": рейсов из Берёзовки " + added);
  }

  // Для направлений без табло города (Минск) берём строки fload.php как есть:
  // времена и дни из таблицы, остановки — Берёзовка и конечная.
  let fallbackAdded = 0;
  for (const s of sourceRows) {
    if (resolved.get(s.to) !== false) continue;
    if (origin.some((r) => routeName(r.route) === s.route && r.t === s.t && r.a === s.a)) continue;
    const stops = [
      { n: hereName, km: 0, dep: s.t, arr: "", addr: stopAddr.get(hereName) || "" },
      { n: s.to, km: 0, dep: "", arr: s.a, addr: stopAddr.get(s.to) || "" },
    ];
    origin.push({
      code: "",
      route: s.route,
      note: s.note || "",
      daysRaw: s.daysRaw,
      dir: "out",
      at: 0,
      t: s.t,
      a: s.a,
      from: stops[0].n,
      to: stops[1].n,
      stops,
      reach: [s.to],
      period: s.t + "/" + s.a,
    });
    fallbackAdded++;
  }
  if (fallbackAdded) console.log("из fload.php добавлено (табло города недоступно):", fallbackAdded);

  // fload.php устаревает: если он показывает время, которого нет на табло
  // города, это повод проверить сайт (см. _tools/divergence.txt).
  for (const dest of dests) {
    if (resolved.get(dest) !== true) continue;
    const boardTimes = new Set(
      origin
        .filter((r) => cityBase(destinationOf(r.route)) === cityBase(dest))
        .map((r) => r.t)
    );
    sourceRows.filter((s) => s.to === dest).forEach((s) => {
      if (!boardTimes.has(s.t)) {
        warnings.push(
          "fload.php показывает " + s.t + " -> " + s.a + " (" + dest +
          "), а на табло города этого рейса нет"
        );
      }
    });
  }

  // Не дублируем рейсы, которые уже пришли с междугородного табло станции.
  const runSig = (r) => [r.dir, routeName(r.route), r.t, r.a].join("|");
  const known = new Set(runs.map(runSig));
  let originAdded = 0;
  for (const r of origin) {
    if (known.has(runSig(r))) continue;
    known.add(runSig(r));
    runs.push(r);
    originAdded++;
  }
  console.log("рейсов из Берёзовки:", origin.length, "| добавлено:", originAdded);
  warnings.forEach((w) => console.log("  предупреждение:", w));

  const out = {
    source: "https://" + HOST + "/ (raspis2 + getstation2 + fload.php: t0 пригород, t1 прямые междугородные; табло городов назначения)",
    station_id: STATION_ID,
    scraped_at: new Date().toISOString(),
    total: runs.length,
    warnings,
    runs,
  };
  fs.writeFileSync(path.join(OUT_DIR, "board.json"), JSON.stringify(out, null, 1), "utf8");
  console.log("готово:", runs.length, "рейсов ->", path.join(OUT_DIR, "board.json"));
  console.log("едут дальше Берёзовки:", runs.filter((r) => r.dir === "out").length,
              "| заканчиваются в Берёзовке:", runs.filter((r) => r.dir === "in").length);
}

main().catch((e) => {
  console.error("ошибка:", e.message);
  process.exit(1);
});
