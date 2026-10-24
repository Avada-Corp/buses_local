#!/usr/bin/env node
"use strict";

// Сборка data.js из данных скрейпера (_tools/live/board.json).
//
//   node _tools/scrape_ticketbus.js    # обновить данные с ticketbus.by
//   node _tools/build_live_data.js     # пересобрать data.js
//
// Формат data.js (window.SCHEDULE):
//   stations[]  — названия остановок, индекс используется в stops
//   addr[]      — адрес/район остановки (параллельно stations)
//   cities[]    — «крупные» пункты (автостанции/автовокзалы), для фильтра
//   trips[]     — рейсы:
//     d    "out" (из Берёзовки) | "in" (в Берёзовку)
//     r    название маршрута из источника
//     t    время на Берёзовке (HH:MM)
//     a    время на конечной этого направления
//     x    true — конечная на следующие/предыдущие сутки
//     w    дни недели 0..6 (0 = понедельник)
//     dl   строка дней для показа, dr — как в источнике
//     note примечание источника («продажа только в автобусе»)
//     at   индекс остановки «БЕРЁЗОВКА АК» в stops
//     p    индекс конечной остановки этого направления, pc — её город (-1 если не крупный)
//     s    остановки: [индекс остановки, км, отправление, прибытие]
//     rc   достижимые крупные пункты: [индекс города, индекс остановки]

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "live", "board.json");
const OUT = path.join(__dirname, "..", "data.js");

const DAYS = [["Пн", 0], ["Вт", 1], ["Ср", 2], ["Чт", 3], ["Пт", 4], ["Сб", 5], ["Вс", 6]];
const toMin = (t) => {
  if (!t || String(t).indexOf(":") < 0) return null;
  const p = String(t).split(":");
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
};

function parseDays(raw) {
  const s = String(raw || "");
  if (/ежедневно/i.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  const set = [];
  s.split(/[^А-Яа-яЁё]+/).forEach((tok) => {
    if (!tok) return;
    const hit = DAYS.find((d) => d[0].toLowerCase() === tok.slice(0, 2).toLowerCase());
    if (hit && set.indexOf(hit[1]) < 0) set.push(hit[1]);
  });
  return set.sort((a, b) => a - b);
}

const dayLabel = (w) => (w.length === 7 ? "ежедневно" : w.map((i) => DAYS[i][0]).join("."));

// На табло бывают обе версии расписания сразу: «… / отменяется с 17.10.26»
// и «… / вводится с 17.10.26;». Держим только ту, что действует на дату сбора.
function dropByChange(text, today) {
  const m = /(отменяется|вводится)\s+с\s+(\d{2})\.(\d{2})\.(\d{2,4})/.exec(String(text || ""));
  if (!m) return "";
  let y = Number(m[4]);
  if (y < 100) y += 2000;
  const d = new Date(y, Number(m[3]) - 1, Number(m[2]));
  if (m[1] === "вводится") return d > today ? "ещё не действует (" + m[0] + ")" : "";
  return d <= today ? "уже отменён (" + m[0] + ")" : "";
}

// «Крупный» пункт — остановка с АС/АВ/АК. У «заезда» сначала снимаем слово «ЗАЕЗД».
// Внимание: \b в JS работает только с латиницей, поэтому проверяем «ЗАЕЗД» через (\s|$).
function cityOf(name) {
  let raw = String(name || "").trim();
  if (/^ЗАЕЗД(\s|$)/i.test(raw)) raw = raw.replace(/^ЗАЕЗД(\s+|$)/i, "").trim();
  const m = raw.match(/\s(АС|АВ|АК)(\s|$)/);
  if (m) return raw.slice(0, m.index).trim();
  if (/^(АС|АВ|АК)(\s|-|$)/.test(raw)) {   // «АВ-Центральный МИНСК»
    const parts = raw.split(/[\s-]+/);
    return (parts[parts.length - 1] || "").toUpperCase();
  }
  return "";
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error("нет " + SRC + " — сначала запустите scrape_ticketbus.js");
  const board = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const scrapeDate = new Date(board.scraped_at || Date.now());
  const today = new Date(scrapeDate.getFullYear(), scrapeDate.getMonth(), scrapeDate.getDate());

  const stations = [], stationIdx = new Map(), addr = [];
  const cities = [], cityIdx = new Map();

  function sidx(name, address) {
    let i = stationIdx.get(name);
    if (i === undefined) {
      i = stations.length;
      stationIdx.set(name, i);
      stations.push(name);
      addr.push(address || "");
    }
    return i;
  }
  function cidx(city) {
    if (!city) return -1;
    let i = cityIdx.get(city);
    if (i === undefined) {
      i = cities.length;
      cityIdx.set(city, i);
      cities.push(city);
    }
    return i;
  }

  const trips = [];
  const skipped = [];

  // На табло один и тот же рейс бывает двумя строками («в продаже» и
  // «продажа только в автобусе») — оставляем одну, предпочитая продажу в кассе онлайн.
  const seenTrips = new Map();
  const notePref = (note) => (String(note || "").indexOf("в продаже") === 0 ? 2 : 1);
  const tripSig = (t) => [t.d, t.t, t.a, t.p, t.dl, t.s.map((s) => s.join(",")).join(">")].join("|");
  let dupDropped = 0;
  function addTrip(t) {
    const sig = tripSig(t);
    const had = seenTrips.get(sig);
    if (had) {
      dupDropped++;
      if (notePref(t.note) > notePref(had.note)) {
        trips[trips.indexOf(had)] = t;
        seenTrips.set(sig, t);
      }
      return;
    }
    seenTrips.set(sig, t);
    trips.push(t);
  }

  board.runs.forEach((run) => {
    const route = String(run.route || "").split(/\s*\/\s*/)[0].trim();
    const note = run.note || "";
    const change = dropByChange(run.daysRaw, today);
    if (change) {
      skipped.push(route + " — " + change);
      return;
    }
    const w = parseDays(run.daysRaw);
    if (!w.length) {
      skipped.push(route + " — дни не разобраны: «" + run.daysRaw + "»");
      return;
    }
    const stops = run.stops.map((s) => [
      sidx(s.n, s.addr),
      Math.round((s.km || 0) * 10) / 10,
      s.dep || "",
      s.arr || "",
    ]);
    const at = run.at;
    if (at < 0 || at >= stops.length) {
      skipped.push(route + " — нет остановки Берёзовка");
      return;
    }

    // из Берёзовки: станция не последняя
    if (at < stops.length - 1) {
      const end = stops[stops.length - 1];
      const t = stops[at][2] || stops[at][3];
      const a = end[3] || end[2];
      const rc = [];
      for (let i = at + 1; i < stops.length; i++) {
        const ci = cidx(cityOf(stations[stops[i][0]]));
        if (ci >= 0 && !rc.some((p) => p[0] === ci)) rc.push([ci, i]);
      }
      addTrip({
        d: "out", r: route, t, a, x: toMin(a) < toMin(t),
        w, dl: dayLabel(w), dr: String(run.daysRaw || "").trim(), note,
        at, p: end[0], pc: cidx(cityOf(stations[end[0]])), s: stops, rc,
      });
    }

    // в Берёзовку: станция не первая
    if (at > 0) {
      const start = stops[0];
      const t = stops[at][3] || stops[at][2];
      const a = start[2] || start[3];
      const rc = [];
      for (let i = 0; i < at; i++) {
        const ci = cidx(cityOf(stations[stops[i][0]]));
        if (ci >= 0 && !rc.some((p) => p[0] === ci)) rc.push([ci, i]);
      }
      addTrip({
        d: "in", r: route, t, a, x: toMin(a) > toMin(t),
        w, dl: dayLabel(w), dr: String(run.daysRaw || "").trim(), note,
        at, p: start[0], pc: cidx(cityOf(stations[start[0]])), s: stops, rc,
      });
    }
  });

  trips.sort((p, q) => (p.d === q.d ? toMin(p.t) - toMin(q.t) : p.d === "out" ? -1 : 1));

  const data = {
    station: "Берёзовка АК",
    source: "https://ticketbus.by/",
    updated: board.scraped_at || "",
    stations, addr, cities, trips,
  };
  const js = "window.SCHEDULE = " + JSON.stringify(data) + ";\n";
  fs.writeFileSync(OUT, js, "utf8");

  const cnt = (d, day) => trips.filter((t) => t.d === d && t.w.indexOf(day) >= 0).length;
  console.log("рейсов:", trips.length,
    "| из Берёзовки:", trips.filter((t) => t.d === "out").length,
    "| в Берёзовку:", trips.filter((t) => t.d === "in").length);
  console.log("остановок:", stations.length, "| крупных пунктов:", cities.length);
  console.log("по дням (Пн..Вс): out", [0, 1, 2, 3, 4, 5, 6].map((i) => cnt("out", i)).join("/"),
    "| in", [0, 1, 2, 3, 4, 5, 6].map((i) => cnt("in", i)).join("/"));
  console.log("сквозных рейсов (конечная не последняя для города):",
    trips.filter((t) => t.rc.length > 1).length);
  if (dupDropped) console.log("дубликатов строк табло убрано:", dupDropped);
  if (skipped.length) console.log("пропущено:", skipped.join("; "));
  console.log("data.js:", (js.length / 1024).toFixed(1), "КБ ->", OUT);
}

main();
