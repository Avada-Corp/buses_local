/* Берёзовка АК · автобусы — service worker
 *
 * Задача: страница и расписание открываются без интернета, а когда интернет
 * есть — данные всегда свежие (network-first). Все пути относительные,
 * поэтому файл годится и для корня сайта, и для подпапки вида /bus/.
 *
 * Меняйте VERSION при изменении списка PRECACHE — старый кэш удалится сам.
 */

"use strict";

var VERSION = "v1";
var CACHE = "berezovka-" + VERSION;

var SCOPE = self.registration.scope;   // абсолютный URL папки со sw.js

// минимум для офлайн-работы; иконки не критичны, но пусть тоже будут
var PRECACHE = [
    "./",
    "./index.html",
    "./data.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/maskable-512.png",
    "./icons/apple-touch-icon.png"
];

var DATA_URL = new URL("./data.js", SCOPE).href;
var INDEX_URL = new URL("./index.html", SCOPE).href;
var MANIFEST_URL = new URL("./manifest.json", SCOPE).href;

/* ---------- установка / активация ---------- */

self.addEventListener("install", function (event) {
    event.waitUntil((async function () {
        var cache = await caches.open(CACHE);
        // addAll падает целиком из-за одного 404 — кладём по одному
        await Promise.all(PRECACHE.map(async function (rel) {
            var url = new URL(rel, SCOPE).href;
            try {
                var res = await fetch(url, { cache: "reload" });
                if (res && res.ok) await cache.put(url, res);
            } catch (e) { /* один файл не скачался — не повод ломать установку */ }
        }));
        await self.skipWaiting();     // новая версия включается сразу
    })());
});

self.addEventListener("activate", function (event) {
    event.waitUntil((async function () {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (key) {
            if (key !== CACHE && key.indexOf("berezovka-") === 0) return caches.delete(key);
        }));
        await self.clients.claim();   // начинаем управлять уже открытой вкладкой
    })());
});

/* ---------- стратегии ---------- */

// сначала сеть (свежее расписание), при обходе — кэш
async function networkFirst(request) {
    var cache = await caches.open(CACHE);
    try {
        var res = await fetch(request);
        if (res && res.ok) cache.put(request, res.clone());
        return res;
    } catch (e) {
        var hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === "navigate") {
            var page = await cache.match(INDEX_URL) || await cache.match(new URL("./", SCOPE).href);
            if (page) return page;
        }
        throw e;
    }
}

// сначала кэш (иконки, мелочь), при промахе — сеть
async function cacheFirst(request) {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    var res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
}

self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;

    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;   // чужие домены не трогаем

    var p = url.pathname;
    // страница, манифест и данные — всегда пробуем сеть
    if (request.mode === "navigate" ||
            p === new URL(DATA_URL).pathname ||
            p === new URL(MANIFEST_URL).pathname) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});

/* ---------- клик по уведомлению: открыть/поднять страницу ---------- */

self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var data = event.notification.data || {};
    var target = data.url ? new URL(data.url, SCOPE).href : SCOPE;

    event.waitUntil((async function () {
        var list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (var i = 0; i < list.length; i++) {
            var client = list[i];
            if (client.url.indexOf(SCOPE) === 0) {
                if ("navigate" in client && client.url !== target) {
                    try { await client.navigate(target); } catch (e) { }
                }
                if ("focus" in client) return client.focus();
                return client;
            }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
    })());
});
