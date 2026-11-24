// npm run preview — раздаёт готовую сборку (папку out) так же, как это делает GitHub Pages:
// сайт лежит в подпапке (по умолчанию /flash), у каждой страницы свой index.html, неизвестные адреса → 404.html.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const out = path.resolve(process.cwd(), "out");
const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "/flash").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
};

function resolveFile(urlPath) {
  if (base && urlPath !== base && !urlPath.startsWith(`${base}/`)) return null;
  const rel = decodeURIComponent(urlPath.slice(base.length)) || "/";
  const target = path.normalize(path.join(out, rel));
  if (!target.startsWith(out)) return null;
  const candidates = rel.endsWith("/") ? [path.join(target, "index.html")] : [target, path.join(target, "index.html")];
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (base && url.pathname === "/") {
      res.writeHead(302, { Location: `${base}/` }).end();
      return;
    }
    let file = resolveFile(url.pathname);
    let status = 200;
    if (!file) {
      file = path.join(out, "404.html");
      status = 404;
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("Not found");
        return;
      }
    }
    const size = fs.statSync(file).size;
    const headers = {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && status === 200) {
      const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] !== "" && range[2] !== "" ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(status, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`Flash: http://localhost:${port}${base}/`));
