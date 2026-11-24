/* Service Worker Flash.
 *
 *  • Оболочка приложения (страницы и статические файлы) кэшируется — приложение открывается без сети.
 *  • Запросы к API и видео в кэш не попадают: данные приватны, а видео отдаётся с перемоткой (Range).
 *  • Push-уведомления: показ, открытие нужного экрана по нажатию, восстановление подписки.
 *
 * В режиме разработки (sw.js?dev=1) кэширование выключено, чтобы не мешать горячей перезагрузке.
 */

const VERSION = "flash-v2";
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";
// Запасной экран — самодостаточный HTML без скриптов приложения: он откроется, даже если
// в кэше нет ни одного файла сборки.
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(PAGES_CACHE);
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" })).catch(() => {});
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

/**
 * Кладёт в кэш скрипты, стили и шрифты, на которые ссылается страница. Без этого сохранённая
 * страница, которую человек ещё ни разу не открывал, без сети показала бы только заставку:
 * её HTML есть, а кода нет.
 */
async function cachePageAssets(html) {
  const cache = await caches.open(STATIC_CACHE);
  const assets = new Set();
  for (const match of html.matchAll(/\/_next\/static\/[A-Za-z0-9_\-./~]+\.(?:js|css|woff2)/g)) assets.add(match[0]);
  await Promise.all(
    [...assets].map(async (asset) => {
      try {
        if (await cache.match(asset)) return;
        const response = await fetch(asset);
        if (response.ok) await cache.put(asset, response);
      } catch {
        /* нет сети — файл докачается при следующем открытии */
      }
    }),
  );
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Страницы: сначала сеть (свежая версия), при неудаче — сохранённая копия, затем экран «нет сети». */
async function handleNavigation(request) {
  const url = new URL(request.url);
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await withTimeout(fetch(request), 6000);
    if (response.ok && response.type === "basic") cache.put(url.pathname, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = (await cache.match(url.pathname)) || (await cache.match(OFFLINE_URL));
    if (cached) return cached;
    return new Response("Нет подключения к интернету", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (DEV || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API, видео и сам воркер всегда идут в сеть.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  // Служебные запросы клиентской навигации Next.js не кэшируем: без сети он сам перейдёт на обычную загрузку страницы.
  if (url.searchParams.has("_rsc") || request.headers.get("RSC") === "1") return;

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/splash/")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
  }
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-shell" && Array.isArray(data.paths) && !DEV) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PAGES_CACHE);
        for (const path of data.paths) {
          if (typeof path !== "string" || !path.startsWith("/")) continue;
          try {
            const response = await fetch(path, { credentials: "same-origin" });
            if (response.ok && response.type === "basic") {
              const html = await response.clone().text();
              await cache.put(path, response);
              await cachePageAssets(html);
            }
          } catch {
            /* нет сети — попробуем в следующий раз */
          }
        }
      })(),
    );
  }
});

// ── Push-уведомления ─────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Flash";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag || "flash",
      renotify: true,
      lang: "ru",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== target) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// Браузер сменил push-подписку (истёк срок, обновились ключи): подписываемся заново и сообщаем серверу.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const options = (event.oldSubscription && event.oldSubscription.options) || { userVisibleOnly: true };
        const subscription = event.newSubscription || (await self.registration.pushManager.subscribe(options));
        const json = subscription.toJSON();
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        });
      } catch {
        /* при следующем запуске приложение восстановит подписку само */
      }
    })(),
  );
});
