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
//   2) POST getdata.php?prog=raspis2&host=1    -> все междугородные рейсы через станцию
//   3) POST getdata.php?prog=getstation2       -> схема остановок каждого рейса
//   4) GET  /fload.php?id=<station>&sys=BJ     -> пригородные рейсы (их нет в raspis2)
//   5) пишет _tools/live/board.html, _tools/live/scheme-<код>.html и board.json
//
// Почему отдельно fload.php: табло raspis2 отдаёт только «МЕЖДУГОРОДНЫЙ».
// Пригородные рейсы (например, БЕРЁЗОВКА АК-ЛИДА АВ) видны только на странице
// табло станции, во второй таблице «ПРИГОРОДНЫЙ». Схемы остановок для них
// getstation2 не отдаёт (внутренняя ошибка сайта), поэтому для таких рейсов
// строим две остановки: наша станция и конечный пункт из названия маршрута.
//
// board.json — по одной записи на рейс:
//   { code, route, note, daysRaw, dir, at, t, a, from, to,
//     stops: [{ n, km, dep, arr, addr }], reach: ["..."] }

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

// Пригородная таблица fload.php. В исходном HTML кириллическая «Р» заменена
// латинской «P» (для шрифта табло), например «БЕPЕЗОВКА АК-ЛИДА АВ» —
// возвращаем буквы на место, иначе не сработают сравнения и разбор дней.
const fixCyrillic = (s) => String(s || "").replace(/P/g, "Р").replace(/p/g, "р");

// Ячейки строки пригорода (разделители — <th>, поэтому в строке 7 <td>):
//   № | маршрут | дни | отпр. с Берёзовки | приб. конечн. | отпр. конечн. | приб. Берёзовка
function parseSuburban(html) {
  const table = (/<table[^>]*id=['"]t0['"][^>]*>([\s\S]*?)<\/table>/i.exec(html) || [, ""])[1];
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
    runs.push({ route, to: m[1].trim(), daysRaw: c[2], t, a });
  }
  return runs;
}

// \b в JS работает только по ASCII, поэтому границу слова проверяем явно
const isStation = (name) => /^БЕР[ЁЕ]ЗОВКА(\s|$)/.test(name);

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

  // Пригородные рейсы: в raspis2 их нет, забираем со страницы табло станции.
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
  // Если таблицы нет, лучше упасть с ошибкой: иначе рейсы молча исчезнут
  // из data.js и сборка закоммитит их удаление.
  if (!/id=['"]t0['"]/i.test(suburbanHtml)) {
    throw new Error("в fload.php нет пригородной таблицы — изменился формат ответа");
  }
  const suburban = parseSuburban(suburbanHtml);

  let suburbanAdded = 0;
  for (const s of suburban) {
    // Если такой рейс уже пришёл из междугородного табло — не дублируем.
    if (runs.some((r) => r.dir === "out" && r.route === s.route && r.t === s.t && r.a === s.a)) continue;
    const stops = [
      {
        n: hereName,
        km: 0,
        dep: s.t,
        arr: "",
        addr: stopAddr.get(hereName) || "",
      },
      {
        n: s.to,
        km: 0,
        dep: "",
        arr: s.a,
        addr: stopAddr.get(s.to) || "",
      },
    ];
    runs.push({
      code: "",
      route: s.route,
      note: "",
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
    suburbanAdded++;
  }
  console.log("пригородных рейсов:", suburban.length, "| добавлено:", suburbanAdded);

  const out = {
    source: "https://" + HOST + "/ (prog=raspis2 + prog=getstation2 + fload.php: пригород)",
    station_id: STATION_ID,
    scraped_at: new Date().toISOString(),
    total: runs.length,
    runs,
  };
  fs.writeFileSync(path.join(OUT_DIR, "board.json"), JSON.stringify(out, null, 1), "utf8");
  console.log("готово:", runs.length, "рейсов ->", path.join(OUT_DIR, "board.json"));
  console.log("из Берёзовки:", runs.filter((r) => r.dir === "out").length,
              "| в Берёзовку:", runs.filter((r) => r.dir === "in").length);
}

main().catch((e) => {
  console.error("ошибка:", e.message);
  process.exit(1);
});
