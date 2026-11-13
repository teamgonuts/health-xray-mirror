// Zero-dependency static server for local development.
// The webcam only works in a secure context, and http://localhost counts as one,
// so this binds to localhost only. Usage: node serve.mjs [port]   (default 8765)
import { createServer } from "node:http";
import { readFile, stat, appendFile, mkdir } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const HOST = process.env.HOST || "localhost";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // Self-test reports from the Health Mirror (poc/?autostart&report=N) are appended to tools/cache/report.jsonl,
    // so a check in a real browser can be read back without driving that browser.
    if (req.method === "POST" && urlPath === "/__report") {
      let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
      await mkdir(join(ROOT, "tools", "cache"), { recursive: true });
      await appendFile(join(ROOT, "tools", "cache", "report.jsonl"), body.replace(/\s+/g, " ").slice(0, 20000) + "\n");
      res.writeHead(204).end(); return;
    }
    let file = normalize(join(ROOT, urlPath));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end("Forbidden"); return; }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(PORT, HOST, () => {
  console.log(`X-Ray Mirror running at http://localhost:${PORT}/`);
  console.log(`Demo scene (no camera):  http://localhost:${PORT}/#demo`);
});
