// npm run test:smoke — короткая проверка production-сборки: страницы отдаются, API отвечает,
// регистрация и удаление аккаунта работают. В отличие от test:e2e не требует воркера и FFmpeg.
//
//   npm run build
//   APP_SECRET=… npm run start            (в одном терминале)
//   npm run test:smoke                    (в другом; адрес — BASE_URL, по умолчанию http://localhost:3000)

import crypto from "node:crypto";
import { deviceYmd } from "@/lib/dates";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const cookies = new Map<string, string>();
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(pathname: string, method = "GET", body?: unknown, withCookies = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (withCookies && cookies.size > 0) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers.origin = BASE;
  const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  if (withCookies) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1).trim();
      if (value) cookies.set(pair.slice(0, eq).trim(), value);
      else cookies.delete(pair.slice(0, eq).trim());
    }
  }
  return res;
}

async function main(): Promise<void> {
  console.log(`Проверка сборки: ${BASE}`);
  const today = deviceYmd();

  const login = await request("/login");
  const loginHtml = await login.text();
  check("страница входа отдаётся", login.status === 200 && loginHtml.includes("Flash"), `HTTP ${login.status}`);
  check("заголовки безопасности на месте", login.headers.get("x-frame-options") === "DENY" && login.headers.get("x-content-type-options") === "nosniff");

  const manifest = await request("/manifest.webmanifest");
  const manifestJson = (await manifest.json().catch(() => ({}))) as { display?: string; icons?: unknown[] };
  check("манифест PWA", manifest.status === 200 && manifestJson.display === "standalone" && (manifestJson.icons?.length ?? 0) >= 3);

  const sw = await request("/sw.js");
  check("service worker отдаётся без кэширования", sw.status === 200 && (sw.headers.get("cache-control") ?? "").includes("no-cache"));
  check("иконка приложения", (await request("/icons/icon-512.png")).status === 200);
  const offline = await request("/offline.html");
  check("запасная офлайн-страница самодостаточна", offline.status === 200 && !(await offline.text()).includes("/_next/"));

  const anon = await request("/api/home?today=" + today, "GET", undefined, false);
  check("API без входа закрыт", anon.status === 401, `HTTP ${anon.status}`);

  const email = `smoke-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(12).toString("base64url");
  const reg = await request("/api/auth/register", "POST", { name: "Smoke", email, password, timezone: "Europe/Kyiv" });
  check("регистрация", reg.status === 200, `HTTP ${reg.status}`);

  const me = await request("/api/me");
  const meJson = (await me.json().catch(() => ({}))) as { user?: { email?: string }; push?: { publicKey?: string | null } };
  check("профиль и ключ Web Push", me.status === 200 && meJson.user?.email === email && !!meJson.push?.publicKey);

  const home = await request("/api/home?today=" + today);
  const homeJson = (await home.json().catch(() => ({}))) as { today?: { limit?: number; count?: number } };
  check("главный экран: лимит 3 момента в день", home.status === 200 && homeJson.today?.limit === 3 && homeJson.today?.count === 0);

  const music = await request("/api/music");
  const musicJson = (await music.json().catch(() => ({}))) as { tracks?: unknown[] };
  check("музыкальная библиотека видна сайту", music.status === 200 && (musicJson.tracks?.length ?? 0) > 0, `${musicJson.tracks?.length ?? 0} композиций`);

  check("список фильмов", (await request("/api/films")).status === 200);
  check("список проектов", (await request("/api/projects?today=" + today)).status === 200);
  check("главная страница приложения", (await request("/")).status === 200);

  const foreign = await fetch(BASE + "/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://evil.example", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: JSON.stringify({ notifications: { enabled: true } }),
  });
  check("запрос с чужого сайта отклонён (CSRF)", foreign.status === 403, `HTTP ${foreign.status}`);

  const wrong = await request("/api/account/delete", "POST", { password: "not-the-password", scope: "account" });
  check("удаление аккаунта требует пароль", wrong.status === 403 || wrong.status === 401 || wrong.status === 400, `HTTP ${wrong.status}`);
  const del = await request("/api/account/delete", "POST", { password, scope: "account" });
  check("аккаунт удалён", del.status === 200, `HTTP ${del.status}`);
  const after = await request("/api/me");
  check("сессия после удаления недействительна", after.status === 401, `HTTP ${after.status}`);

  console.log(failed === 0 ? "\nВсё в порядке." : `\nНе прошло проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
