#!/usr/bin/env node
"use strict";

// Сверка рейсов, которые НАЧИНАЮТСЯ в Берёзовке, с поиском ticketbus.by.
//
//   node _tools/check_directions.js [station_id]
//
// Почему только «начинающиеся»: поиск (prog=marshrut1) показывает лишь рейсы,
// которые продаются онлайн. Для проходящих через Берёзовку он неполный
// (например, Новогрудок: 2 из 20), а для начинающихся у нас совпадает с табло
// города назначения 1:1 — на них и проверяем.
//
// Результат: _tools/divergence.txt (пустой, если всё совпало).
// Код возврата: 0 — совпало, 2 — есть расхождения, 1 — техническая ошибка.

const https = require("https");
const fs = require("fs");
const path = require("path");

const HOST = "ticketbus.by";
const STATION_ID = process.argv[2] || "409012";
const ROOT = path.join(__dirname, "..");
const DIVERGENCE = path.join(__dirname, "divergence.txt");
const DAYS_AHEAD = 7;
const REQUEST_TIMEOUT = 30000; // сайт иногда принимает соединение и молчит

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isStation = (s) => /^БЕР[ЁЕ]ЗОВКА(\s|$)/.test(String(s || ""));
const routeName = (r) => String(r || "").split(/\s*\/\s*/)[0].trim();
const cityBase = (name) => String(name || "").replace(/\s+(АВ|АК|АС)$/i, "").trim().toUpperCase();

function destinationOf(route) {
  const m = /^БЕР[ЁЕ]ЗОВКА\s*АК\s*-\s*(.+)$/i.exec(routeName(route));
  return m ? m[1].trim() : "";
}

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
          "x-requested-with": "XMLHttpRequest",
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
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error("нет ответа за " + REQUEST_TIMEOUT / 1000 + " с"));
    });
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

// Строки поиска: маршрут | … | отправление с Берёзовки | прибытие на конечную
function siteRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1])
    .filter((raw) => /showclick\(/.test(raw))
    .map((raw) => {
      const c = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      return { route: c[1] || "", dep: c[4] || "", arr: c[5] || "" };
    })
    .filter((r) => /^БЕР[ЁЕ]ЗОВКА\s*АК/i.test(r.route) && TIME.test(r.dep));
}

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
const shortDate = (iso) => iso.slice(0, 5);

async function main() {
  const window = {};
  eval(fs.readFileSync(path.join(ROOT, "data.js"), "utf8"));
  const S = window.SCHEDULE || {};
  const stations = S.stations || [];

  // Рейсы, у которых Берёзовка — первая остановка (то есть рейс начинается у нас).
  const ours = (S.trips || []).filter(
    (t) => t.d === "out" && Array.isArray(t.s) && t.s.length && isStation(stations[t.s[0][0]])
  );

  const groups = new Map(); // «ЛИДА» -> { name, trips: [...] }
  ours.forEach((t) => {
    const dest = destinationOf(t.r) || stations[t.s[t.s.length - 1][0]];
    const base = cityBase(dest);
    if (!base) return;
    if (!groups.has(base)) groups.set(base, { name: dest, trips: [] });
    groups.get(base).trips.push(t);
  });

  const home = await request("/", "");
  const sid = (home.match(/PHPSESSID=([a-z0-9]+)/) || [])[1];
  if (!sid) throw new Error("не удалось получить PHPSESSID");
  const api = "/getdata.php?PHPSESSID=" + sid;

  const cityHtml = await request(api + "&prog=getcity", "prog=getcity");
  const cities = [...cityHtml.matchAll(/<option value='(\d+)' >([^<]+)<\/option>/g)]
    .map((m) => ({ id: m[1], name: m[2].trim() }));

  // Ближайшие 7 дней, по одному разу на каждый день недели.
  const dates = [];
  const now = new Date();
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    dates.push({ iso: fmtDate(d), wd: (d.getDay() + 6) % 7 }); // 0 = понедельник
  }

  const lines = [];
  let problems = 0;

  console.log("сверка с ticketbus.by: рейсы, начинающиеся в Берёзовке");
  console.log("  дней:", DAYS_AHEAD, "| направлений у нас:", groups.size);

  for (const [base, group] of groups) {
    const city = cities.find((c) => cityBase(c.name) === base);
    if (!city) {
      // Минска в списке городов поиска нет вовсе — это не ошибка данных.
      console.log("  " + group.name + ": нет в списке городов поиска — пропуск");
      continue;
    }

    const issues = new Map(); // kind|dep -> { kind, dep, arr, dates }
    const add = (kind, dep, arr, iso) => {
      const key = kind + "|" + dep;
      if (!issues.has(key)) issues.set(key, { kind, dep, arr, dates: [] });
      const item = issues.get(key);
      if (item.dates.indexOf(iso) < 0) item.dates.push(iso);
    };

    let siteSeen = 0; // сколько строк вернул поиск за все 7 дней

    for (const date of dates) {
      const body =
        "station_id=" + city.id +
        "&station_id1=" + STATION_ID +
        "&date=" + date.iso +
        "&online=&path=1&mparent=0&codest=";
      const rows = siteRows(await request(api + "&prog=marshrut1&host=1", body));
      siteSeen += rows.length;

      const site = new Map();
      rows.forEach((r) => { if (!site.has(r.dep)) site.set(r.dep, r.arr || ""); });

      const dayOurs = group.trips.filter((t) => (t.w || []).indexOf(date.wd) >= 0);
      const mine = new Map();
      dayOurs.forEach((t) => { if (!mine.has(t.t)) mine.set(t.t, t.a || ""); });

      site.forEach((arr, dep) => {
        if (!mine.has(dep)) {
          add("missing", dep, arr, date.iso); // есть на сайте, нет у нас
        } else if (arr && mine.get(dep) && arr !== mine.get(dep)) {
          add("arrival", dep, mine.get(dep) + "→" + arr, date.iso); // другое прибытие
        }
      });
      mine.forEach((arr, dep) => {
        if (!site.has(dep)) add("extra", dep, arr, date.iso); // есть у нас, нет на сайте
      });
    }

    // Если поиск не показал ни одной строки за все 7 дней, сверять нечего:
    // так бывает, когда на рейс нет онлайн-продажи (например, Минск —
    // «продажа только в автобусе»). Это не расхождение.
    if (!siteSeen) {
      console.log(
        "  " + group.name + " (" + city.id + "): поиск ничего не показывает" +
        " (продажа только в автобусе) — пропуск"
      );
      continue;
    }

    if (!issues.size) {
      console.log("  " + group.name + " (" + city.id + "): совпадает — " + group.trips.length + " рейсов");
      continue;
    }

    problems++;
    console.log("  " + group.name + " (" + city.id + "): РАСХОЖДЕНИЯ");
    lines.push(group.name + " (" + city.id + "):");

    const kinds = { missing: [], extra: [], arrival: [] };
    issues.forEach((item) => kinds[item.kind].push(item));

    kinds.missing.forEach((it) => {
      const s = "  на сайте есть, у нас нет: " + it.dep + (it.arr ? " → " + it.arr : "") +
        " — " + it.dates.map(shortDate).join(", ");
      console.log(s);
      lines.push(s);
    });
    kinds.extra.forEach((it) => {
      const s = "  у нас есть, на сайте нет: " + it.dep + (it.arr ? " → " + it.arr : "") +
        " — " + it.dates.map(shortDate).join(", ");
      console.log(s);
      lines.push(s);
    });
    kinds.arrival.forEach((it) => {
      const s = "  другое время прибытия: " + it.dep +
        " (у нас " + it.arr.split("→")[0] + ", на сайте " + it.arr.split("→")[1] + ")" +
        " — " + it.dates.map(shortDate).join(", ");
      console.log(s);
      lines.push(s);
    });
  }

  if (!problems) {
    fs.writeFileSync(DIVERGENCE, "", "utf8");
    console.log("расхождений нет");
    return 0;
  }

  const stamp = new Date().toLocaleString("ru-RU");
  const report = [stamp + " — расхождения с ticketbus.by (рейсы из Берёзовки)"]
    .concat(lines)
    .join("\r\n") + "\r\n";
  fs.writeFileSync(DIVERGENCE, report, "utf8");
  console.log("подробности: " + DIVERGENCE);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const stamp = new Date().toLocaleString("ru-RU");
    const message = "не удалось выполнить сверку: " + e.message;
    console.log("ошибка: " + e.message);
    try {
      fs.writeFileSync(DIVERGENCE, stamp + " — " + message + "\r\n", "utf8");
    } catch (_) { /* файл не критичен */ }
    process.exit(1);
  });
