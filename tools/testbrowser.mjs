// A separate Chrome for automated testing and speed measurements, driven over the DevTools protocol.
// It uses its own throwaway profile (tools/cache/chrome-profile), never the user's Chrome profile.
//
//   node tools/testbrowser.mjs start [--headed] [--camera poc/data/qa-camera.mjpeg]
//   node tools/testbrowser.mjs nav "http://localhost:8765/poc/?demo"
//   node tools/testbrowser.mjs eval "document.title"          (or: eval @script.js ; top-level await works)
//   node tools/testbrowser.mjs shot out.png [selector]
//   node tools/testbrowser.mjs stop
//
// With --camera, getUserMedia() is answered by that .mjpeg/.y4m file (looped) and the permission prompt is
// accepted automatically, so the real camera path can be tested without a person in front of a webcam.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, "tools", "cache");
const stateFile = join(cache, "testbrowser.json");
const PORT = 9333;
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

const [cmd, ...args] = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

async function target() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const page = list.find(t => t.type === "page");
  if (!page) throw new Error("no page in the test browser");
  return page.webSocketDebuggerUrl;
}
async function cdp(calls) {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cannot connect to the test browser; run: node tools/testbrowser.mjs start")); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  try { return await calls(send); } finally { ws.close(); }
}

if (cmd === "start") {
  mkdirSync(cache, { recursive: true });
  const profile = join(cache, "chrome-profile");
  const flags = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=CalculateNativeWinOcclusion,Translate", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--use-fake-ui-for-media-stream", "--window-size=1500,1000", "--window-position=40,40"];
  if (!flag("--headed")) flags.push("--headless=new");
  const cam = opt("--camera");
  if (cam) flags.push("--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${resolve(root, cam)}`);
  flags.push(...args.filter(a => a.startsWith("--") && !["--headed", "--camera"].includes(a) && a.includes("=")), "about:blank");
  const child = spawn(CHROME, flags, { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, flags }));
  for (let i = 0; i < 50; i++) { try { await target(); console.log("test browser ready, pid", child.pid, flag("--headed") ? "(headed)" : "(headless)"); process.exit(0); } catch { await new Promise(r => setTimeout(r, 200)); } }
  console.error("test browser did not come up"); process.exit(1);
} else if (cmd === "nav") {
  await cdp(async send => { await send("Page.enable"); await send("Page.navigate", { url: args[0] }); await new Promise(r => setTimeout(r, +(args[1] || 1500))); });
  console.log("navigated");
} else if (cmd === "eval") {
  let src = args[0]; if (src.startsWith("@")) src = readFileSync(src.slice(1), "utf8");
  const r = await cdp(send => send("Runtime.evaluate", { expression: `(async () => { ${src.includes("return ") ? src : "return (" + src + ")"} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 }));
  if (r.result?.exceptionDetails) { console.error("page error:", r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); process.exit(1); }
  console.log(typeof r.result?.result?.value === "string" ? r.result.result.value : JSON.stringify(r.result?.result?.value, null, 1));
} else if (cmd === "shot") {
  const sel = args[1];
  await cdp(async send => {
    let clip;
    if (sel) {
      const r = await send("Runtime.evaluate", { expression: `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`, returnByValue: true });
      clip = r.result.result.value;
    }
    const s = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(args[0], Buffer.from(s.result.data, "base64"));
  });
  console.log("saved", args[0]);
} else if (cmd === "stop") {
  try { await cdp(send => send("Browser.close")); } catch {}
  try { rmSync(stateFile); } catch {}
  console.log("stopped");
} else {
  console.log("usage: node tools/testbrowser.mjs start|nav|eval|shot|stop   (see the comment at the top of this file)");
}
