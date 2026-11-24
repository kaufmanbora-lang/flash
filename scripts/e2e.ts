// npm run test:e2e — сквозная проверка работающего приложения (сайт + воркер должны быть запущены).
//
// Сценарий: регистрация двух пользователей → push-подписка и расшифровка уведомления →
// напоминание от планировщика с текстом о проекте → загрузка видео частями → обработка →
// лимит 3 в день → отказ для видео короче 10 секунд → фильмы (полный и Highlights) настоящим FFmpeg →
// проект с паузой, продлением и финальным фильмом → изоляция данных → экспорт архива → удаление.
//
//   BASE_URL=http://localhost:3000 npm run test:e2e
//
// Для проверки push сайт и воркер должны быть запущены с PUSH_ALLOW_ANY_ENDPOINT=1 (только вне production).

import "@/lib/load-env";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { addDays, deviceHm, deviceYmd, minutesToHm } from "@/lib/dates";
import { ffmpeg, killAllFfmpeg, probe } from "@/worker/ffmpeg";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const results: { name: string; ok: boolean; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

class Client {
  private cookies = new Map<string, string>();
  constructor(readonly label: string) {}

  async raw(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(BASE + pathname, { ...init, headers, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async json<T = Record<string, unknown>>(pathname: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.raw(pathname, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  }
}

interface Moment {
  id: string;
  status: string;
  error: string | null;
  durationMs: number;
  width: number;
  height: number;
  videoUrl: string | null;
  posterUrl: string | null;
  projectIds: string[];
}
interface Film {
  id: string;
  status: string;
  progress: number;
  stage: string;
  error: string | null;
  hasFile: boolean;
  videoUrl: string | null;
  downloadUrl: string | null;
  durationMs: number;
  width: number;
  height: number;
  musicTracks: string[];
  styleUsed: string | null;
  momentsCount: number;
  chapters: unknown[];
}

// ── Тестовый push-сервис ─────────────────────────────────────

interface PushMessage {
  headers: Record<string, string | string[] | undefined>;
  title: string;
  body: string;
  url: string;
  kind: string;
}

/** Расшифровка сообщения Web Push (RFC 8291, aes128gcm) ключами «устройства». */
function decryptPush(payload: Buffer, device: crypto.ECDH, auth: Buffer): string {
  const salt = payload.subarray(0, 16);
  const keyLength = payload[20];
  const serverKey = payload.subarray(21, 21 + keyLength);
  const encrypted = payload.subarray(21 + keyLength);
  const shared = device.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), serverKey]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (end > 0 && plain[end - 1] === 2) end--;
  return plain.subarray(0, end).toString("utf8");
}

async function startPushService() {
  const device = crypto.createECDH("prime256v1");
  device.generateKeys();
  const auth = crypto.randomBytes(16);
  const received: PushMessage[] = [];
  // Одноразовый самоподписанный сертификат: настоящие push-сервисы работают только по https.
  const cert = await selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }]);
  const server = https.createServer({ key: cert.private, cert: cert.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = decryptPush(Buffer.concat(chunks), device, auth);
        const data = JSON.parse(text) as { title: string; body: string; url: string; kind: string };
        received.push({ headers: req.headers, ...data });
      } catch (err) {
        received.push({ headers: req.headers, title: "", body: `не расшифровано: ${(err as Error).message}`, url: "", kind: "error" });
      }
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    received,
    subscription: {
      endpoint: `https://127.0.0.1:${port}/push/e2e`,
      keys: { p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
    async waitFor(predicate: (m: PushMessage) => boolean, timeoutMs: number): Promise<PushMessage | null> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const hit = received.find(predicate);
        if (hit) return hit;
        if (Date.now() > until) return null;
        await sleep(500);
      }
    },
    close: () => server.close(),
  };
}

// ── Загрузка и ожидание ──────────────────────────────────────

async function upload(
  client: Client,
  file: string,
  opts: { date: string; time?: string; note?: string; mime?: string; projectIds?: string[]; autoProjects?: boolean },
) {
  const data = await fs.readFile(file);
  const recordedAt = new Date(`${opts.date}T${opts.time ?? deviceHm()}:00`).toISOString();
  const init = await client.json<{ moment: Moment; chunkBytes: number; uploadedParts: number[]; error?: string }>("/api/moments", "POST", {
    clientId: `e2e${crypto.randomBytes(10).toString("hex")}`,
    recordedAt,
    localDate: opts.date,
    localTime: opts.time ?? deviceHm(),
    note: opts.note ?? "",
    source: "upload",
    mime: opts.mime ?? "video/mp4",
    sizeBytes: data.length,
    durationMs: 0,
    projectIds: opts.projectIds ?? [],
    autoProjects: opts.autoProjects ?? false,
  });
  if (init.status !== 200) return { status: init.status, error: init.data.error, moment: null as Moment | null };
  const { moment, chunkBytes } = init.data;
  const parts = Math.ceil(data.length / chunkBytes);
  for (let n = 1; n <= parts; n++) {
    const res = await client.raw(`/api/moments/${moment.id}/parts/${n}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: data.subarray((n - 1) * chunkBytes, Math.min(data.length, n * chunkBytes)),
    });
    if (!res.ok) throw new Error(`часть ${n}: HTTP ${res.status}`);
  }
  const done = await client.json<{ moment: Moment }>(`/api/moments/${moment.id}/complete`, "POST", {});
  return { status: done.status, error: undefined, moment: done.data.moment };
}

async function waitMoment(client: Client, id: string, timeoutMs = 180_000): Promise<Moment> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client.json<{ moment: Moment }>(`/api/moments/${id}`);
    if (data.moment && (data.moment.status === "ready" || data.moment.status === "failed")) return data.moment;
    if (Date.now() > until) throw new Error(`момент ${id} не обработался за ${timeoutMs / 1000} с`);
    await sleep(1000);
  }
}

async function waitFilm(client: Client, id: string, timeoutMs = 600_000): Promise<Film> {
  const until = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const { data } = await client.json<{ film: Film }>(`/api/films/${id}`);
    const film = data.film;
    const line = `${film.status} ${Math.round(film.progress * 100)}% ${film.stage}`;
    if (line !== last) {
      process.stdout.write(`      ${line}\n`);
      last = line;
    }
    if (film.status === "ready" || film.status === "failed") return film;
    if (Date.now() > until) throw new Error(`фильм ${id} не собрался за ${timeoutMs / 1000} с`);
    await sleep(1500);
  }
}

async function download(client: Client, url: string, file: string): Promise<number> {
  const res = await client.raw(url);
  if (!res.ok) throw new Error(`скачивание: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  return buf.length;
}

async function makeClips(dir: string) {
  // Синтетические видео с «речью» (пульсирующий тон) — на них видно и монтаж, и приглушение музыки.
  const tone = (freq: number) => `sine=frequency=${freq}:sample_rate=48000,volume='0.05+0.5*gt(sin(2*PI*t/3),0.2)':eval=frame`;
  await ffmpeg(
    ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30", "-f", "lavfi", "-i", tone(440), "-t", "12",
     "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "portrait.mp4"],
    { cwd: dir },
  );
  await ffmpeg(
    ["-f", "lavfi", "-i", "smptehdbars=size=1280x720:rate=25", "-f", "lavfi", "-i", tone(330), "-t", "11",
     "-c:v", "libvpx", "-b:v", "1500k", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest", "landscape.webm"],
    { cwd: dir },
  );
  await ffmpeg(
    ["-f", "lavfi", "-i", "mandelbrot=size=540x960:rate=30", "-t", "14", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "silent.mp4"],
    { cwd: dir },
  );
  await ffmpeg(
    ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "short.mp4"],
    { cwd: dir },
  );
  return {
    portrait: path.join(dir, "portrait.mp4"),
    landscape: path.join(dir, "landscape.webm"),
    silent: path.join(dir, "silent.mp4"),
    short: path.join(dir, "short.mp4"),
  };
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flash-e2e-"));
  const today = deviceYmd();
  const yesterday = addDays(today, -1);
  const stamp = Date.now().toString(36);
  const pushService = await startPushService();
  console.log(`Проверяю ${BASE}\n`);

  try {
    console.log("Подготовка тестовых видео");
    const clips = await makeClips(dir);
    check("FFmpeg создал тестовые видео", true);

    // ── Аккаунты ─────────────────────────────────────────────
    console.log("\nРегистрация и вход");
    const alice = new Client("alice");
    const bob = new Client("bob");
    const password = `pw-${crypto.randomBytes(9).toString("hex")}`;
    const reg = await alice.json("/api/auth/register", "POST", {
      name: "Алиса", email: `alice-${stamp}@example.com`, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    check("регистрация", reg.status === 200, `HTTP ${reg.status}`);
    const regB = await bob.json("/api/auth/register", "POST", { name: "Боб", email: `bob-${stamp}@example.com`, password });
    check("регистрация второго пользователя", regB.status === 200);
    const dup = await new Client("dup").json("/api/auth/register", "POST", { name: "X", email: `alice-${stamp}@example.com`, password });
    check("повторная почта отклоняется", dup.status === 409);
    const anon = await new Client("anon").json("/api/home");
    check("без входа API закрыт", anon.status === 401);
    const relogin = new Client("alice-2");
    const bad = await relogin.json("/api/auth/login", "POST", { email: `alice-${stamp}@example.com`, password: "wrong-password" });
    check("неверный пароль отклоняется", bad.status === 401);
    const good = await relogin.json("/api/auth/login", "POST", { email: `alice-${stamp}@example.com`, password });
    check("вход с верным паролем", good.status === 200);
    const me = await alice.json<{ user: { name: string }; limits: { maxPerDay: number }; push: { publicKey: string | null } }>("/api/me");
    check("профиль доступен", me.data.user?.name === "Алиса" && me.data.limits.maxPerDay === 3);
    check("VAPID-ключ выдан", typeof me.data.push.publicKey === "string" && me.data.push.publicKey.length > 60);

    // ── Проект (создаётся заранее, чтобы моменты попали в него при загрузке) ──
    console.log("\nПроект воспоминаний");
    const proj = await alice.json<{ id: string }>("/api/projects", "POST", {
      title: "7 дней e2e", description: "Проверочная история", periodKind: "d7", startDate: today, today, includeExisting: true,
    });
    check("проект на 7 дней создан", proj.status === 200 && !!proj.data.id);
    const projectId = proj.data.id;

    // ── Push ─────────────────────────────────────────────────
    console.log("\nPush-уведомления");
    const sub = await alice.json<{ error?: string }>("/api/push/subscribe", "POST", pushService.subscription);
    let pushEnabled = false;
    if (sub.status === 400 && sub.data.error === "bad_push_endpoint") {
      check("сервер принимает подписки только настоящих push-сервисов", true, "локальный адрес отклонён; для полной проверки запустите сайт и воркер с PUSH_ALLOW_ANY_ENDPOINT=1");
    } else {
      pushEnabled = true;
      check("подписка сохранена", sub.status === 200);
      const test = await alice.json<{ delivered: number }>("/api/push/test", "POST", {});
      const got = await pushService.waitFor((m) => m.kind === "test", 5000);
      check("пробное уведомление доставлено и расшифровано ключами устройства", test.data.delivered === 1 && got?.title === "Flash на связи", got ? `«${got.title}» — ${got.body}` : "не получено");
      check(
        "запрос зашифрован (aes128gcm) и подписан VAPID",
        got?.headers["content-encoding"] === "aes128gcm" && /^vapid /i.test(String(got?.headers.authorization ?? "")),
        `ttl=${String(got?.headers.ttl)}`,
      );
      const bobTest = await bob.json<{ delivered: number }>("/api/push/test", "POST", {});
      check("чужие устройства уведомление не получают", bobTest.data.delivered === 0 && pushService.received.filter((m) => m.kind === "test").length === 1);

      // Напоминание от серверного планировщика: расписание «сейчас и через минуту».
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const times = [minutesToHm(minutes), minutesToHm(minutes + 1), minutesToHm(minutes + 2)].filter((t, i, list) => list.indexOf(t) === i && t >= minutesToHm(minutes));
      await alice.json("/api/settings", "PATCH", { notifications: { enabled: true, mode: "fixed", fixedTimes: times, quietEnabled: false } });
      console.log(`      жду напоминание планировщика (расписание ${times.join(", ")})…`);
      const reminder = await pushService.waitFor((m) => m.kind === "reminder", 150_000);
      check(
        "планировщик прислал напоминание с прогрессом проекта",
        reminder?.body === "День 1 из 7. Сохрани сегодняшний момент!" && reminder.title === "«7 дней e2e»" && reminder.url === "/record",
        reminder ? `${reminder.title}: ${reminder.body}` : "не получено за 150 с (воркер запущен с PUSH_ALLOW_ANY_ENDPOINT=1?)",
      );
    }

    // ── Загрузка и обработка ─────────────────────────────────
    console.log("\nЗагрузка моментов (частями) и обработка");
    const m1 = await upload(alice, clips.portrait, { date: today, time: "09:15", note: "Утро у моря", projectIds: [projectId] });
    const m2 = await upload(alice, clips.landscape, { date: today, time: "13:40", note: "Дорога", mime: "video/webm", projectIds: [projectId] });
    // Третий момент не называет проекты сам (так сохраняется восстановленная прерванная запись):
    // сервер должен добавить его во все идущие проекты.
    const m3 = await upload(alice, clips.silent, { date: today, time: "19:05", autoProjects: true });
    check("три момента загружены", [m1, m2, m3].every((m) => m.status === 200 && m.moment));
    check("момент без выбора проектов сам попал в идущий проект", m3.moment?.projectIds.includes(projectId) === true);
    const r1 = await waitMoment(alice, m1.moment!.id);
    const r2 = await waitMoment(alice, m2.moment!.id);
    const r3 = await waitMoment(alice, m3.moment!.id);
    check("вертикальное MP4 обработано", r1.status === "ready" && Math.abs(r1.durationMs - 12000) < 600 && r1.height > r1.width, `${r1.durationMs} мс, ${r1.width}×${r1.height}`);
    check("WebM перекодирован для воспроизведения", r2.status === "ready" && !!r2.videoUrl?.includes("playback.mp4"), `${r2.durationMs} мс`);
    check("видео без звука обработано", r3.status === "ready" && !!r3.posterUrl);

    const fourth = await upload(alice, clips.portrait, { date: today, time: "21:00" });
    check("четвёртый момент за день отклонён (лимит 3)", fourth.status === 409 && fourth.error === "daily_limit", `HTTP ${fourth.status} ${fourth.error ?? ""}`);

    // Видео из галереи с датой вне периода проекта: загружается, но в проект не попадает.
    const lastYear = addDays(today, -365);
    const old = await upload(alice, clips.portrait, { date: lastYear, time: "18:30", projectIds: [projectId] });
    check("момент вне периода проекта в проект не добавляется", old.status === 200 && old.moment?.projectIds.length === 0, `проектов: ${old.moment?.projectIds.length}`);
    if (old.moment) {
      // Дальнейшие проверки считают моменты — убираем этот, заодно проверяя удаление записи за прошлый год.
      await waitMoment(alice, old.moment.id);
      const removed = await alice.json(`/api/moments/${old.moment.id}`, "DELETE");
      check("момент за прошлый год удаляется", removed.status === 200);
    }

    const short = await upload(alice, clips.short, { date: yesterday, time: "12:00" });
    const shortDone = short.moment ? await waitMoment(alice, short.moment.id) : null;
    check("видео короче 10 секунд не сохраняется", shortDone?.status === "failed" && shortDone.error === "too_short", shortDone?.error ?? "");

    const home = await alice.json<{ today: { count: number; durationMs: number }; streak: { current: number }; projects: { id: string; momentsCount: number }[] }>(`/api/home?today=${today}`);
    check("главный экран: 3 момента сегодня", home.data.today.count === 3 && home.data.today.durationMs > 30000);
    check("серия дней началась", home.data.streak.current === 1);
    check("моменты попали в проект", home.data.projects.find((p) => p.id === projectId)?.momentsCount === 3);

    const search = await alice.json<{ moments: Moment[] }>(`/api/moments?q=${encodeURIComponent("море")}`);
    check("поиск по заметке с учётом словоформ («море» → «у моря»)", search.data.moments.length === 1 && search.data.moments[0].id === r1.id);
    // Регистр кириллицы не должен зависеть от локали базы: «Утро» в заметке находится и по «утро», и по «УТРО».
    const lower = await alice.json<{ moments: Moment[] }>(`/api/moments?q=${encodeURIComponent("утро")}`);
    const upper = await alice.json<{ moments: Moment[] }>(`/api/moments?q=${encodeURIComponent("УТРО У МОРЯ")}`);
    check(
      "поиск не зависит от регистра кириллицы («утро», «УТРО У МОРЯ» → «Утро у моря»)",
      lower.data.moments.length === 1 && lower.data.moments[0].id === r1.id && upper.data.moments.length === 1 && upper.data.moments[0].id === r1.id,
    );
    const byDate = await alice.json<{ moments: Moment[] }>(`/api/moments?q=${encodeURIComponent(today)}`);
    check("поиск по дате", byDate.data.moments.length === 3);
    const fav = await alice.json(`/api/moments/${r1.id}`, "PATCH", { favorite: true });
    const favs = await alice.json<{ moments: Moment[] }>("/api/moments?favorite=1");
    check("избранное", fav.status === 200 && favs.data.moments.length === 1);

    // ── Доступ к файлам ──────────────────────────────────────
    console.log("\nПриватность и подписанные ссылки");
    const ranged = await new Client("no-cookie").raw(r1.videoUrl!, { headers: { range: "bytes=0-1023" } });
    check("видео отдаётся по подписанной ссылке с Range", ranged.status === 206 && ranged.headers.get("content-range")?.startsWith("bytes 0-1023/") === true);
    const tampered = await alice.raw(r1.videoUrl!.replace(/s=[^&]+/, "s=AAAA"));
    check("подделанная подпись отклоняется", tampered.status === 403);
    const swapped = await alice.raw(r1.videoUrl!.replace(r1.id, r2.id));
    check("подпись не подходит к другому файлу", swapped.status === 403);
    const foreign = await bob.json(`/api/moments/${r1.id}`);
    check("чужой момент недоступен", foreign.status === 404);
    const foreignPatch = await bob.json(`/api/moments/${r1.id}`, "PATCH", { note: "взлом" });
    const foreignDelete = await bob.json(`/api/moments/${r1.id}`, "DELETE");
    check("чужой момент нельзя изменить или удалить", foreignPatch.status === 404 && foreignDelete.status === 404);
    const bobList = await bob.json<{ moments: Moment[] }>("/api/moments");
    const bobProject = await bob.json(`/api/projects/${projectId}?today=${today}`);
    check("у второго пользователя пусто, чужой проект не виден", bobList.data.moments.length === 0 && bobProject.status === 404);

    // ── Фильм дня ────────────────────────────────────────────
    console.log("\nМонтаж фильма дня (полный, стиль Cinematic, Relaxing Piano)");
    const created = await alice.json<{ film: Film }>("/api/films", "POST", {
      kind: "day", dateFrom: today, dateTo: today, variant: "full", style: "cinematic", music: "relaxing-piano", musicVolume: 0.6,
    });
    check("фильм поставлен в очередь", created.status === 200 && ["queued", "rendering"].includes(created.data.film.status));
    const film = await waitFilm(alice, created.data.film.id);
    check("фильм собран", film.status === "ready" && film.hasFile, film.error ?? "");
    if (film.hasFile && film.downloadUrl) {
      const file = path.join(dir, "film-full.mp4");
      const size = await download(alice, film.downloadUrl, file);
      const info = await probe(file);
      // 12 + 11 + 14 секунд клипов + вступление 3.6 + финал 3.6 − четыре перехода.
      check("MP4: H.264 + AAC", info.vcodec === "h264" && info.acodec === "aac", `${info.vcodec}/${info.acodec}, ${(size / 1e6).toFixed(1)} МБ`);
      check("длительность соответствует монтажу", info.durationSec > 38 && info.durationSec < 46, `${info.durationSec.toFixed(1)} с`);
      check("вертикальный кадр не ниже 720p", info.height > info.width && info.width >= 720, `${info.width}×${info.height}`);
      check("музыка подобрана из выбранного стиля", film.musicTracks.length > 0 && film.musicTracks.every((t) => t.startsWith("relaxing-piano")), film.musicTracks.join(", "));
      check("стиль применён", film.styleUsed === "cinematic");
    }
    if (pushEnabled) {
      const ready = await pushService.waitFor((m) => m.kind === "film_ready" && m.url === `/films/${film.id}`, 8000);
      check("уведомление о готовом фильме", ready?.title === "Фильм готов", ready ? `${ready.title}: ${ready.body}` : "не получено");
    }

    console.log("\nВерсия Highlights");
    const hl = await alice.json<{ film: Film }>("/api/films", "POST", { kind: "day", dateFrom: today, dateTo: today, variant: "highlights", style: "auto", music: "auto" });
    const hlFilm = await waitFilm(alice, hl.data.film.id);
    check("Highlights собран и короче полного", hlFilm.status === "ready" && hlFilm.durationMs < film.durationMs, `${(hlFilm.durationMs / 1000).toFixed(1)} с против ${(film.durationMs / 1000).toFixed(1)} с`);
    check("авто-стиль выбран, музыка сменилась", !!hlFilm.styleUsed && hlFilm.musicTracks.length > 0 && hlFilm.musicTracks[0] !== film.musicTracks[0], `${hlFilm.styleUsed ?? ""}, ${hlFilm.musicTracks.join(", ")}`);

    console.log("\nПересборка без музыки");
    const re = await alice.json<{ film: Film }>(`/api/films/${film.id}`, "PATCH", { music: "none", style: "vintage" });
    check("пересборка принята, прежний файл доступен", re.status === 200 && re.data.film.hasFile);
    const reFilm = await waitFilm(alice, film.id);
    check("фильм пересобран в другом стиле без музыки", reFilm.status === "ready" && reFilm.styleUsed === "vintage" && reFilm.musicTracks.length === 0);

    // ── Проект ───────────────────────────────────────────────
    console.log("\nУправление проектом");
    type Detail = { project: { status: string; endDate: string | null; progress: { dayIndex: number; totalDays: number | null }; variants: { variant: string; available: boolean; film: Film | null }[]; momentsCount: number; cover: { url: string | null } } };
    const d0 = await alice.json<Detail>(`/api/projects/${projectId}?today=${today}`);
    check("проект: день 1 из 7", d0.data.project.progress.dayIndex === 1 && d0.data.project.progress.totalDays === 7);
    check("обложка проекта собрана из кадров", !!d0.data.project.cover.url?.includes("/cover-"), d0.data.project.cover.url?.split("?")[0] ?? "нет");
    check("полная версия доступна, расширенная — нет", d0.data.project.variants.find((v) => v.variant === "full")?.available === true && d0.data.project.variants.find((v) => v.variant === "extended")?.available === false);
    const paused = await alice.json<Detail>(`/api/projects/${projectId}`, "PATCH", { today, action: "pause" });
    check("пауза", paused.data.project.status === "paused");
    const resumed = await alice.json<Detail>(`/api/projects/${projectId}`, "PATCH", { today, action: "resume" });
    check("продолжение", resumed.data.project.status === "active" && resumed.data.project.endDate === addDays(today, 6));
    const extended = await alice.json<Detail>(`/api/projects/${projectId}`, "PATCH", { today, action: "extend", days: 7 });
    check("продление на 7 дней", extended.data.project.endDate === addDays(today, 13));
    const trailer = await alice.json<{ error?: string }>(`/api/projects/${projectId}/films`, "POST", { variant: "extended" });
    check("версия без достаточного материала отклоняется", trailer.status === 400 && trailer.data.error === "not_enough_footage");
    const trailerOk = await alice.json<{ film: Film }>(`/api/projects/${projectId}/films`, "POST", { variant: "trailer" });
    check("трейлер проекта поставлен в очередь", trailerOk.status === 200);
    const trailerFilm = await waitFilm(alice, trailerOk.data.film.id);
    check("трейлер собран (промежуточный фильм активного проекта)", trailerFilm.status === "ready" && trailerFilm.durationMs < 62_000, `${(trailerFilm.durationMs / 1000).toFixed(1)} с`);
    const finished = await alice.json<Detail>(`/api/projects/${projectId}`, "PATCH", { today, action: "complete" });
    check("досрочное завершение", finished.data.project.status === "completed");
    const full = finished.data.project.variants.find((v) => v.variant === "full")?.film;
    check("финальный фильм запущен автоматически", !!full);
    if (full) {
      const done = await waitFilm(alice, full.id);
      check("финальный фильм проекта собран", done.status === "ready" && done.momentsCount === 3, done.error ?? "");
      if (pushEnabled) {
        const ready = await pushService.waitFor((m) => m.kind === "film_ready" && m.url === `/films/${full.id}`, 8000);
        check("уведомление «Твой фильм готов»", ready?.title === "Твой фильм готов" && ready.body === "Время пережить эти моменты снова.", ready ? `${ready.title}. ${ready.body}` : "не получено");
      }
    }

    // ── Экспорт и удаление ───────────────────────────────────
    console.log("\nЭкспорт архива и удаление данных");
    const zip = await alice.raw("/api/account/export");
    const zipBuf = Buffer.from(await zip.arrayBuffer());
    check("архив — корректный ZIP с видео", zip.status === 200 && zipBuf.subarray(0, 2).toString() === "PK" && zipBuf.includes("flash-archive.json") && zipBuf.length > 1_000_000, `${(zipBuf.length / 1e6).toFixed(1)} МБ`);
    const storage = await alice.json<{ storage: { totalBytes: number; moments: number; films: number } }>("/api/account/storage");
    check("занятое место посчитано", storage.data.storage.totalBytes > 1_000_000 && storage.data.storage.moments === 3 && storage.data.storage.films >= 2);

    const del = await alice.json(`/api/moments/${r3.id}`, "DELETE");
    const after = await alice.json<{ today: { count: number } }>(`/api/home?today=${today}`);
    const gone = await alice.raw(r3.posterUrl!);
    check("удаление момента освобождает слот дня и стирает файлы", del.status === 200 && after.data.today.count === 2 && gone.status === 404);

    const wrong = await alice.json("/api/account/delete", "POST", { password: "nope", scope: "data" });
    check("удаление данных требует пароль", wrong.status === 403);
    const wipe = await alice.json("/api/account/delete", "POST", { password, scope: "data" });
    const empty = await alice.json<{ totals: { moments: number }; projects: unknown[] }>(`/api/home?today=${today}`);
    const filmsAfter = await alice.json<{ films: unknown[] }>("/api/films");
    const fileAfter = await alice.raw(r1.videoUrl!);
    check("все данные удалены", wipe.status === 200 && empty.data.totals.moments === 0 && empty.data.projects.length === 0 && filmsAfter.data.films.length === 0 && fileAfter.status === 404);
    const account = await alice.json("/api/account/delete", "POST", { password, scope: "account" });
    const afterAccount = await alice.json("/api/me");
    check("аккаунт удалён, сессия закрыта", account.status === 200 && afterAccount.status === 401);
    await bob.json("/api/account/delete", "POST", { password, scope: "account" });
  } finally {
    pushService.close();
    killAllFfmpeg();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтог: ${results.length - failed.length} из ${results.length} проверок пройдено`);
  if (failed.length > 0) {
    console.log("Не пройдено:");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nСценарий прерван:", err);
  killAllFfmpeg();
  process.exit(1);
});
