// Проверка data.js: структура рейсов, остановки, города, покрытие дней.
// Запуск: node _tools/check_data.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "data.js");
const window = {};
eval(fs.readFileSync(SRC, "utf8"));          // data.js пишет window.SCHEDULE
const S = window.SCHEDULE || {};

let bad = 0;
const err = (m) => { bad++; console.log("  ✗ " + m); };
const isStation = (s) => /^БЕР[ЁЕ]ЗОВКА(\s|$)/.test(String(s || ""));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

if (!S.trips || !S.trips.length) err("в SCHEDULE нет рейсов");
const stations = S.stations || [];
const cities = S.cities || [];
const trips = S.trips || [];

trips.forEach((t, i) => {
  const who = "рейс #" + i + " (" + t.d + " " + t.r + " " + t.t + ")";
  if (t.d !== "out" && t.d !== "in") err(who + ": неизвестное направление " + t.d);
  if (!TIME.test(t.t || "")) err(who + ": плохое время у Берёзовки «" + t.t + "»");
  if (t.a && !TIME.test(t.a)) err(who + ": плохое время на конечной «" + t.a + "»");
  if (!Array.isArray(t.w) || !t.w.length) err(who + ": нет дней недели");
  (t.w || []).forEach((d) => { if (!(d >= 0 && d <= 6)) err(who + ": день вне 0..6 — " + d); });
  if (!Array.isArray(t.s) || t.s.length < 2) err(who + ": меньше двух остановок");
  const here = (t.s || []).filter((st) => isStation(stations[st[0]]));
  if (here.length !== 1) err(who + ": остановок Берёзовки " + here.length + ", должна быть одна");
  if (!Array.isArray(t.rc) || !t.rc.length) err(who + ": пустой список пунктов rc");
  (t.rc || []).forEach((p) => {
    if (!(p[0] >= 0 && p[0] < cities.length)) err(who + ": город вне списка — " + p[0]);
    if (!(p[1] >= 0 && p[1] < t.s.length)) err(who + ": остановка вне рейса — " + p[1]);
  });
  if (t.pc >= 0 && !(t.pc < cities.length)) err(who + ": конечный пункт вне списка городов");
  (t.s || []).forEach((st) => {
    if (!stations[st[0]]) err(who + ": неизвестная остановка " + st[0]);
    if (!(st[1] >= 0)) err(who + ": отрицательное расстояние");
    if (st[2] && !TIME.test(st[2])) err(who + ": плохое отправление «" + st[2] + "» у " + stations[st[0]]);
    if (st[3] && !TIME.test(st[3])) err(who + ": плохое прибытие «" + st[3] + "» у " + stations[st[0]]);
  });
});

const out = trips.filter((t) => t.d === "out");
const inn = trips.filter((t) => t.d === "in");
[0, 1, 2, 3, 4, 5, 6].forEach((d) => {
  const o = out.filter((t) => t.w.indexOf(d) >= 0).length;
  const n = inn.filter((t) => t.w.indexOf(d) >= 0).length;
  if (!o) err("нет рейсов «из Берёзовки» в день " + d);
  if (!n) err("нет рейсов «в Берёзовку» в день " + d);
});

const seen = Object.create(null);
trips.forEach((t) => {
  const k = [t.d, t.t, t.p, t.dl].join("|");
  if (seen[k]) err("дубликат рейса: " + k);
  seen[k] = 1;
});

const placeOut = new Set(), placeIn = new Set();
trips.forEach((t) => (t.rc || []).forEach((p) => (t.d === "out" ? placeOut : placeIn).add(cities[p[0]])));

console.log("всего рейсов: " + trips.length + " (из Берёзовки " + out.length + ", в Берёзовку " + inn.length + ")");
console.log("остановок: " + stations.length + " | крупных пунктов: " + cities.length);
console.log("пункты «из Берёзовки» (" + placeOut.size + "): " + Array.from(placeOut).sort().join(", "));
console.log("пункты «в Берёзовку»  (" + placeIn.size + "): " + Array.from(placeIn).sort().join(", "));
console.log(bad ? "ошибок: " + bad : "проверки пройдены ✔");
process.exit(bad ? 1 : 0);
