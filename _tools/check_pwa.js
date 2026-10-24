// Проверка PWA: манифест, регистрация service worker, офлайн-режим.
// Запуск: node _tools/check_pwa.js  (нужен python или node для статики)
//
// Поднимает локальный http-сервер (localhost = защищённый контекст, поэтому SW
// работает без HTTPS), открывает страницу в headless Chrome и проверяет:
//   1) manifest.json читается и содержит нужные поля;
//   2) service worker установился и активировался;
//   3) страница и data.js лежат в кэше;
//   4) после отключения сети страница открывается из кэша.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PWA_PORT || 8425);
const CDP_PORT = Number(process.env.CDP_PORT || 9337);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMES = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function startServer() {
    const args = ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"];
    const proc = spawn("python", args, { cwd: ROOT, stdio: "ignore", windowsHide: true });
    proc.on("error", () => { });
    return proc;
}

async function main() {
    const chromePath = CHROMES.find(p => fs.existsSync(p));
    if (!chromePath) throw new Error("не найден Chrome/Edge");

    const server = startServer();
    await sleep(900);

    const profile = path.join(os.tmpdir(), "cdp-pwa-" + Date.now());
    const chrome = spawn(chromePath, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + profile, "about:blank",
    ], { stdio: "ignore" });

    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
        await sleep(250);
        try {
            wsUrl = (await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json()).webSocketDebuggerUrl;
        } catch (e) { }
    }
    if (!wsUrl) { chrome.kill(); server.kill(); throw new Error("не дождались CDP"); }

    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params, sessionId) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params: params || {}, sessionId }));
    });
    ws.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
    });
    await new Promise(r => ws.addEventListener("open", r));

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);

    const evaluate = async (expression, waitForPromise) => {
        const r = await send("Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: !!waitForPromise }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " +
            JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
        return r.result.value;
    };

    const url = "http://localhost:" + PORT + "/index.html";
    const problems = [];
    const ok = (cond, text) => {
        console.log((cond ? "  ✔ " : "  ✘ ") + text);
        if (!cond) problems.push(text);
    };

    await send("Page.navigate", { url }, sessionId);
    await sleep(1500);

    // 1. манифест
    const manifest = await evaluate(`fetch("manifest.json").then(r => r.ok ? r.json() : null)`, true);
    ok(!!manifest, "manifest.json отдаётся сервером");
    ok(manifest && manifest.icons && manifest.icons.length >= 3, "в манифесте есть иконки (192/512/maskable)");
    ok(manifest && manifest.display === "standalone", "display: standalone");
    const iconOk = await evaluate(
        `Promise.all(${JSON.stringify((manifest && manifest.icons || []).map(i => i.src))}
            .map(s => fetch(s).then(r => r.ok))).then(a => a.every(Boolean))`, true);
    ok(iconOk, "все иконки из манифеста доступны");

    // 2. service worker
    const sw = await evaluate(`(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return { state: "нет регистрации" };
        return { state: reg.active ? reg.active.state : "нет active", scope: reg.scope };
    })()`, true);
    ok(!!sw && sw.state === "activated", "service worker активирован (" + (sw && sw.state) + ")");

    // 3. кэш
    await sleep(600);
    const cache = await evaluate(`(async () => {
        const keys = await caches.keys();
        if (!keys.length) return { keys: [], count: 0, urls: [] };
        const c = await caches.open(keys[0]);
        const reqs = await c.keys();
        return { keys, count: reqs.length, urls: reqs.map(r => new URL(r.url).pathname) };
    })()`, true);
    ok(cache.keys.some(k => k.indexOf("berezovka") === 0), "кэш " + JSON.stringify(cache.keys) + " создан");
    ok(cache.urls.some(u => /index\.html$/.test(u)), "index.html в кэше");
    ok(cache.urls.some(u => /data\.js$/.test(u)), "data.js в кэше");

    // 4. офлайн
    await send("Network.emulateNetworkConditions",
        { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    await send("Page.reload", {}, sessionId);
    await sleep(1800);
    const offline = await evaluate(`({
        title: document.title,
        trips: document.querySelectorAll("li.trip").length,
        text: (document.body.innerText || "").length
    })`, false);
    ok(offline.trips > 0, "без сети страница отрисовалась из кэша (рейсов: " + offline.trips + ")");
    ok(offline.text > 500, "текст страницы на месте (" + offline.text + " символов)");

    await send("Network.emulateNetworkConditions",
        { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);

    ws.close();
    chrome.kill();
    server.kill();
    await sleep(300);

    if (problems.length) {
        console.log("\nпроблемы (" + problems.length + "):");
        problems.forEach(p => console.log("  - " + p));
        process.exit(1);
    }
    console.log("\nпроверки пройдены ✔");
    process.exit(0);
}

main().catch(e => { console.error("ОШИБКА:", e.message); process.exit(1); });
