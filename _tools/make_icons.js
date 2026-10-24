// Иконки PWA: рисуем SVG и снимаем его в PNG через headless Chrome (CDP).
// Запуск: node _tools/make_icons.js
// Результат: icons/icon-192.png, icon-512.png, maskable-512.png,
//            apple-touch-icon.png (180), badge-72.png (белый силуэт на прозрачном).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.CDP_PORT || 9336);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMES = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

// ---------- сам значок ----------

const BG = "#0b0f12";
const ACCENT = "#45d67f";

// автобус сбоку: корпус, окна, два колеса (glyph — координаты в поле 512×512)
function busGlyph(fill, glass) {
    return `
    <g>
      <rect x="86" y="150" width="340" height="172" rx="28" fill="${fill}"/>
      <rect x="126" y="176" width="86" height="74" rx="12" fill="${glass}"/>
      <rect x="226" y="176" width="86" height="74" rx="12" fill="${glass}"/>
      <rect x="330" y="176" width="72" height="74" rx="14" fill="${glass}"/>
      <circle cx="172" cy="320" r="30" fill="${fill}"/>
      <circle cx="172" cy="320" r="12" fill="${glass}"/>
      <circle cx="340" cy="320" r="30" fill="${fill}"/>
      <circle cx="340" cy="320" r="12" fill="${glass}"/>
    </g>`;
}

// «any»-иконка: тёмный фон с зелёным свечением сверху (как у самой страницы)
function iconSVG(size, scale, glyph) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-8%" r="92%">
      <stop offset="0" stop-color="#0e1a17"/>
      <stop offset=".62" stop-color="${BG}"/>
      <stop offset="1" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#glow)"/>
  <g transform="translate(256 258) scale(${scale}) translate(-256 -258)">${glyph}</g>
</svg>`;
}

// maskable: значок меньше (безопасная зона ~80% и диаметр), фон на всю площадь
const MASKABLE = iconSVG(512, 0.82, busGlyph(ACCENT, BG));

// «any»: чуть крупнее, со скруглением под квадратную иконку
const ICON_512 = iconSVG(512, 1, busGlyph(ACCENT, BG));

// badge: только белый силуэт, фон прозрачный — Android рисует его как маску
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 512 512">
  <g fill="#ffffff">
    <rect x="86" y="150" width="340" height="172" rx="28"/>
    <circle cx="172" cy="320" r="30"/>
    <circle cx="340" cy="320" r="30"/>
  </g>
</svg>`;

const OUT_DIR = path.join(__dirname, "..", "icons");
const JOBS = [
    { file: "icon-512.png", size: 512, svg: ICON_512, bg: BG },
    { file: "icon-192.png", size: 192, svg: ICON_512, bg: BG },
    { file: "maskable-512.png", size: 512, svg: MASKABLE, bg: BG },
    { file: "apple-touch-icon.png", size: 180, svg: ICON_512, bg: BG },
    { file: "badge-72.png", size: 72, svg: BADGE, bg: null },
];

function html(svg, size) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        "html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
        `svg{display:block;width:${size}px;height:${size}px}` +
        "</style></head><body>" + svg + "</body></html>";
}

// ---------- CDP ----------

async function main() {
    const chromePath = CHROMES.find(p => fs.existsSync(p));
    if (!chromePath) throw new Error("не найден Chrome/Edge");

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const profile = path.join(os.tmpdir(), "cdp-icons-" + Date.now());
    const chrome = spawn(chromePath, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--hide-scrollbars", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
        "about:blank",
    ], { stdio: "ignore" });

    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
        await sleep(250);
        try {
            wsUrl = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json()).webSocketDebuggerUrl;
        } catch (e) { }
    }
    if (!wsUrl) { chrome.kill(); throw new Error("не дождались CDP на порту " + PORT); }

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

    for (const job of JOBS) {
        const s = job.size;
        await send("Emulation.setDeviceMetricsOverride",
            { width: s, height: s, deviceScaleFactor: 1, mobile: false }, sessionId);
        // прозрачный фон нужен только значку в статус-баре
        await send("Emulation.setDefaultBackgroundColorOverride",
            job.bg ? { color: { r: 11, g: 15, b: 18, a: 1 } } : { color: { r: 0, g: 0, b: 0, a: 0 } },
            sessionId);
        await send("Page.navigate",
            { url: "data:text/html;charset=utf-8," + encodeURIComponent(html(job.svg, s)) }, sessionId);
        await sleep(300);

        const shot = await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: s, height: s, scale: 1 },
            captureBeyondViewport: false,
        }, sessionId);

        const out = path.join(OUT_DIR, job.file);
        fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
        console.log("  " + job.file + "  " + s + "×" + s + "  " +
            fs.statSync(out).size + " байт");
    }

    ws.close();
    chrome.kill();
    await sleep(300);
    console.log("готово: " + OUT_DIR);
    process.exit(0);
}

main().catch(e => { console.error("ОШИБКА:", e.message); process.exit(1); });
