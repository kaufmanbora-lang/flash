/* Service Worker Flash.
 *
 * Flash — набор статических файлов без сервера. Воркер при установке кладёт в кэш всю сборку
 * (страницы, скрипты, шрифты, иконки), поэтому приложение открывается и работает без интернета.
 * Музыка для фильмов кэшируется по мере использования. Данные дневника (видео, фильмы) живут
 * в IndexedDB и через воркер не проходят.
 *
 * Сайт может делить адрес с другими сайтами (на GitHub Pages — username.github.io),
 * поэтому воркер трогает только свои кэши (с приставкой flash-) и только запросы внутри своей папки.
 */

const VERSION = "__BUILD_ID__";
const STATIC_PREFIX = "flash-static-";
const STATIC = `${STATIC_PREFIX}${VERSION}`;
const MEDIA = "flash-media-v1";
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, "");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch(`${BASE}/precache.json?v=${VERSION}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`precache.json: HTTP ${res.status}`);
      const { files } = await res.json();
      const cache = await caches.open(STATIC);
      // Небольшими пачками: сотни одновременных запросов мобильная сеть не любит.
      for (let i = 0; i < files.length; i += 8) {
        await Promise.all(
          files.slice(i, i + 8).map(async (path) => {
            const response = await fetch(`${BASE}${path}`, { cache: "no-cache" });
            if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
            await cache.put(`${BASE}${path}`, response);
          }),
        );
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Предыдущая сборка остаётся: открытая вкладка со старой версией ещё может догружать её файлы.
      const mine = (await caches.keys()).filter((key) => key.startsWith(STATIC_PREFIX) && key !== STATIC);
      for (const key of mine.slice(0, -1)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Ищет файл в текущей сборке, затем в предыдущих. */
async function fromStatic(key, options) {
  const current = await caches.open(STATIC);
  const hit = await current.match(key, options);
  if (hit) return hit;
  for (const name of (await caches.keys()).reverse()) {
    if (!name.startsWith(STATIC_PREFIX) || name === STATIC) continue;
    const old = await (await caches.open(name)).match(key, options);
    if (old) return old;
  }
  return undefined;
}

/** Ответ на запрос части файла (плееру нужна перемотка): вырезает диапазон из закэшированного файла. */
async function ranged(response, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return response;
  const blob = await response.blob();
  const size = blob.size;
  let start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  let end = match[1] !== "" && match[2] !== "" ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function media(request) {
  const cache = await caches.open(MEDIA);
  const url = request.url;
  let cached = await cache.match(url);
  if (!cached) {
    // В кэш кладём файл целиком, даже если плеер попросил только его часть.
    const full = await fetch(url);
    if (!full.ok || full.status !== 200) return full;
    await cache.put(url, full.clone());
    cached = full;
  }
  const range = request.headers.get("Range");
  return range ? ranged(cached, range) : cached;
}

async function page(request, url) {
  let path = url.pathname;
  if (!path.endsWith("/") && !/\.[a-z0-9]+$/i.test(path)) path += "/";
  const key = path.endsWith("/") ? `${path}index.html` : path;
  // Сначала сеть не нужна: страницы лежат в кэше сборки. Параметры адреса (?id=…) читает само приложение.
  const hit = await fromStatic(key);
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch {
    return (await fromStatic(`${BASE}/index.html`)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${BASE}/`)) return;
  if (url.pathname === `${BASE}/sw.js` || url.pathname === `${BASE}/precache.json`) return;

  if (url.pathname.startsWith(`${BASE}/music/`) && !url.pathname.endsWith(".json")) {
    event.respondWith(media(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(page(request, url));
    return;
  }
  event.respondWith(
    (async () => {
      // У файлов сборки имя уже содержит отпечаток содержимого; у остальных параметры (?_rsc=…) не важны.
      const hit = await fromStatic(`${url.origin}${url.pathname}`);
      return hit || fetch(request);
    })(),
  );
});
