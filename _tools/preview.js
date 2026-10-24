// Скриншот/замер страницы через CDP: node _tools/preview.js <url> <out.png|-> <w> <h> [light|dark] [full|view] [js]
const { spawn } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9334);
const [url, out, wArg, hArg, scheme, mode, jsInit] = process.argv.slice(2);
const width = parseInt(wArg || "390", 10);
const height = parseInt(hArg || "844", 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MEASURE = `(() => {
  const out = { innerWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflowing: [] };
  document.querySelectorAll("body *").forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1) out.overflowing.push(
      el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + " right=" + Math.round(r.right));
  });
  return JSON.stringify(out.overflowing.length ? out : { innerWidth: out.innerWidth, scrollWidth: out.scrollWidth });
})()`;

async function main() {
  const profile = path.join(os.tmpdir(), "cdp-prev-" + Date.now());
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try { wsUrl = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json()).webSocketDebuggerUrl; }
    catch (e) { }
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
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);
  if (scheme) await send("Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: scheme }] }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await sleep(1500);
  if (jsInit) {
    const r = await send("Runtime.evaluate", { expression: jsInit, returnByValue: true }, sessionId);
    if (r.result && r.result.value !== undefined) console.log("  →", JSON.stringify(r.result.value));
    await sleep(500);
  }

  const m = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true }, sessionId);
  console.log(width + "px:", m.result.value);

  if (out && out !== "-") {
    let clip = null;
    if (mode === "full") {
      const h = await send("Runtime.evaluate",
        { expression: "Math.ceil(document.documentElement.scrollHeight)", returnByValue: true }, sessionId);
      clip = { x: 0, y: 0, width, height: Math.min(h.result.value, 5000), scale: 1 };
    }
    const shot = await send("Page.captureScreenshot",
      { format: "png", captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) }, sessionId);
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("  файл:", out, fs.statSync(out).size, "байт");
  }

  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(0);
}

main().catch(e => { console.error("ОШИБКА:", e.message); process.exit(1); });
