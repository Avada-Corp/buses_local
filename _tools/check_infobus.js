#!/usr/bin/env node
"use strict";

// Сверка с infobus.by: какие рейсы из Берёзовки там ПРОДАЮТСЯ, но у нас
// в data.js отсутствуют.
//
//   node _tools/check_infobus.js [city_id] [slug]
//
// infobus.by показывает только те рейсы, на которые есть онлайн-продажа,
// и только по конечным/продаваемым пунктам (промежуточных времён не даёт).
// Поэтому сверяем по времени отправления с Берёзовки:
//   1) есть ли у нас рейс в это время до этого пункта;
//   2) если нет — есть ли вообще рейс в это время (пункт может быть
//      промежуточным, а infobus продаёт до него отдельно).
// Расхождением считается только отсутствующее время отправления.
//
// Результат дописывается в _tools/divergence.txt (его же пишет
// check_directions.js), поэтому запускать этот скрипт нужно после него.
// Код возврата: 0 — расхождений нет, 2 — есть, 1 — техническая ошибка.

const https = require("https");
const fs = require("fs");
const path = require("path");

const CITY_ID = process.argv[2] || "11505";              // Берёзовка (город)
const SLUG = process.argv[3] || "beryozovka-lidskiy-rn"; // для страниц маршрутов
const ROOT = path.join(__dirname, "..");
const DATA_FILE = process.env.BUSES_DATA || path.join(ROOT, "data.js");
const DIVERGENCE = path.join(__dirname, "divergence.txt");
const CACHE = path.join(__dirname, "live", "infobus_cities.json");
const CACHE_DAYS = 30;

// Две даты с разными днями недели: за неделю ежедневных запусков
// покрываются все дни, а один запрос на пункт не раздувает нагрузку.
const DAY_OFFSETS = [1, 4];
const REQUEST_TIMEOUT = 30000;

const HOST = "infobus.by";
const SITEMAP = "/sitemap/sitemap-ru.xml";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n) => String(n).padStart(2, "0");
const toMin = (t) => {
  const m = String(t || "").match(/^(\d\d):(\d\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

function fetchUrl(pathname, method, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: pathname,
        method: method || "GET",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; berezovka-buses/1.0)",
          accept: "text/html,application/json",
          ...(body
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "x-requested-with": "XMLHttpRequest",
                origin: "https://" + HOST,
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return resolve({ status: res.statusCode, loc: res.headers.location || "", body: "" });
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, loc: "", body: data }));
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

async function get(pathname) {
  for (let i = 1; i <= 2; i++) {
    const r = await fetchUrl(pathname, "GET");
    if (r.status === 200 && r.body) return r.body;
    if (i === 2) throw new Error("GET " + pathname + " -> " + r.status);
  }
}

async function post(fields) {
  const body = Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  for (let i = 1; i <= 2; i++) {
    const r = await fetchUrl("/ru/script", "POST", body);
    if (r.status === 200 && r.body) return r.body;
    if (i === 2) throw new Error("POST /ru/script -> " + r.status);
  }
}

const text = (html) =>
  String(html).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// «Берёзовка - Гродно» -> «ГРОДНО»; «МИНСК АВ Центральный» -> «МИНСК»
function placeBase(name) {
  let s = String(name || "").toUpperCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^ЗАЕЗД\s+/, "");
  if (/^(АВ|АК|АС)(\s|-)/.test(s)) return s.split(/[\s-]+/).pop() || s;
  const m = s.match(/\s(АВ|АК|АС)(\s|$)/);
  if (m) return s.slice(0, m.index).trim();
  return s;
}

// Название карточки reysа -> пункт продажи
function destinationOf(routeName) {
  const parts = String(routeName || "").split(/\s+[-–—]\s+/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : "";
}

const attr = (html, name) => {
  const m = html.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : "";
};

const cleanBrand = (s) =>
  String(s || "").replace(/\(UNP[^)]*\)/gi, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();

const fmt = (d) => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1), "utf8");
  } catch (_) { /* кэш не критичен */ }
}

async function destinationIds(slugs) {
  const cache = loadCache();
  const today = new Date();
  const ids = new Map();
  let fetched = 0;

  for (const slug of slugs) {
    const hit = cache[slug];
    const fresh = hit && hit.at && (today - new Date(hit.at)) / 86400000 < CACHE_DAYS;
    if (fresh && hit.id) {
      ids.set(slug, hit.id);
      continue;
    }
    try {
      const page = await get("/bus/route/from-" + SLUG + "-to-" + slug);
      const id = attr(page, "data-city-to-id");
      if (!id) continue;
      ids.set(slug, id);
      cache[slug] = { id, at: today.toISOString() };
      fetched++;
    } catch (e) {
      // один недоступный пункт не должен ломать всю сверку
      console.log("  " + slug + ": " + e.message + " — пропуск");
    }
  }

  if (fetched) saveCache(cache);
  return ids;
}

async function routesFor(cityId, dateIso) {
  const body = await post({
    Function: "get_routes",
    city_from_id: CITY_ID,
    city_to_id: cityId,
    dateFrom: dateIso,
    transport_type: "bus",
    is_cache: "0",
    cache_only: "0",
    screen_width: "1366",
    screen_height: "768",
  });
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error("infobus вернул не JSON");
  }
  return (data.routes || []).map((r) => {
    const h = r.html || "";
    const dep = attr(h, "data-deptime_fltr"); // «2135»
    const arr = attr(h, "data-arrtime_fltr");
    return {
      dep: /^\d{4}$/.test(dep) ? dep.slice(0, 2) + ":" + dep.slice(2) : "",
      arr: /^\d{4}$/.test(arr) ? arr.slice(0, 2) + ":" + arr.slice(2) : "",
      route: text(attr(h, "data-route-name")),
      brand: cleanBrand(attr(h, "data-item-brand")),
    };
  });
}

function appendReport(section) {
  let prev = "";
  try {
    prev = fs.readFileSync(DIVERGENCE, "utf8");
  } catch (_) { /* файла ещё нет */ }
  prev = prev.replace(/\s+$/, "");
  fs.writeFileSync(DIVERGENCE, (prev ? prev + "\r\n\r\n" : "") + section + "\r\n", "utf8");
}

const daysLabel = (w) => {
  const names = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  return w.length === 7 ? "ежедневно" : w.map((i) => names[i]).join(".");
};

async function main() {
  const sandbox = { window: {} };
  new Function("window", fs.readFileSync(DATA_FILE, "utf8"))(sandbox.window);
  const S = sandbox.window.SCHEDULE || {};
  const stations = S.stations || [];
  const cities = S.cities || [];
  const ours = (S.trips || []).filter((t) => t.d === "out");

  const sitemap = await get(SITEMAP);
  const slugs = [];
  const re = new RegExp("/bus/route/from-" + SLUG + "-to-([^<]+)</loc>", "g");
  let m;
  while ((m = re.exec(sitemap))) slugs.push(m[1]);
  if (!slugs.length) throw new Error("в sitemap не найдено направлений из Берёзовки");

  const dates = DAY_OFFSETS.map((k) => {
    const d = new Date();
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
    return { iso: fmt(x), wd: (x.getDay() + 6) % 7, short: fmt(x).slice(0, 5) };
  });

  console.log("сверка с infobus.by: что продаётся из Берёзовки");
  console.log("  дат: " + dates.length + " (" + dates.map((d) => d.short).join(", ") +
    ") | направлений в каталоге: " + slugs.length);

  const ids = await destinationIds(slugs);
  if (!ids.size) throw new Error("не удалось определить ни одного города назначения");

  const found = new Map(); // dep|brand -> { dep, brand, points: Map(dest -> arr), dates: [] }
  let sold = 0;

  for (const date of dates) {
    for (const [slug, cityId] of ids) {
      let routes;
      try {
        routes = await routesFor(cityId, date.iso);
      } catch (e) {
        console.log("  " + slug + ": " + e.message + " — пропуск");
        continue;
      }
      for (const r of routes) {
        if (!TIME.test(r.dep)) continue;
        sold++;
        const dest = destinationOf(r.route);
        const destBase = placeBase(dest);

        // Время отправления уже занято нашим рейсом — считаем, что рейс есть:
        // infobus продаёт и до промежуточных пунктов, поэтому конечный пункт
        // в названии карточки не обязан совпадать с пунктом нашего рейса.
        const sameTime = ours.filter((t) => t.t === r.dep && (t.w || []).indexOf(date.wd) >= 0);
        if (sameTime.length) continue;

        // Один и тот же рейс infobus продаёт до нескольких пунктов
        // (Гончары, Гостиловцы…). Группируем по времени и перевозчику.
        const key = r.dep + "|" + r.brand;
        if (!found.has(key)) {
          found.set(key, { dep: r.dep, brand: r.brand, points: new Map(), dates: [] });
        }
        const item = found.get(key);
        const old = item.points.get(destBase);
        if (old === undefined || toMin(r.arr) > toMin(old)) item.points.set(destBase, r.arr);
        if (item.dates.indexOf(date.short) < 0) item.dates.push(date.short);
      }
    }
  }

  if (!found.size) {
    console.log("  рейсов в продаже: " + sold + " | расхождений нет");
    return 0;
  }

  const lines = [];
  found.forEach((it) => {
    // конечный пункт продажи — тот, куда рейс приходит позже всех
    const pts = [...it.points.entries()].sort((a, b) => toMin(b[1]) - toMin(a[1]));
    const main = pts[0] || ["", ""];
    const rest = pts.slice(1).map((p) => p[0]);

    // есть ли у нас такой рейс в другие дни — чтобы отчёт не пугал зря
    const otherDays = ours.filter(
      (t) => t.t === it.dep && (t.rc || []).some((p) => placeBase(cities[p[0]]) === main[0])
    );
    const note = otherDays.length
      ? " (у нас только " + daysLabel([...new Set(otherDays.flatMap((t) => t.w))].sort()) + ")"
      : " (у нас нет)";

    let s = "  " + it.dep + (main[1] ? " → " + main[1] : "") +
      " · " + main[0] + (it.brand ? " · " + it.brand : "") +
      " — " + it.dates.join(", ") + note;
    if (rest.length) s += " (продаётся также до: " + rest.join(", ") + ")";
    console.log(s);
    lines.push(s);
  });

  const stamp = new Date().toLocaleString("ru-RU");
  appendReport(
    [stamp + " — infobus.by: есть в продаже, нет у нас"]
      .concat(lines)
      .join("\r\n")
  );

  console.log("  подробности дописаны: " + DIVERGENCE);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.log("ошибка сверки с infobus.by: " + e.message);
    process.exit(1);
  });
