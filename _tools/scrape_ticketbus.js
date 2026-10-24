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
//   2) POST getdata.php?prog=raspis2&host=1    -> все рейсы через станцию
//   3) POST getdata.php?prog=getstation2       -> схема остановок каждого рейса
//   4) пишет _tools/live/board.html, _tools/live/scheme-<код>.html и board.json
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

function request(pathname, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: pathname,
        method: "POST",
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

  const out = {
    source: "https://" + HOST + "/ (prog=raspis2 + prog=getstation2)",
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
