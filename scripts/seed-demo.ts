// npm run seed — наполняет локальную установку демонстрационными данными, чтобы посмотреть приложение
// «в жизни»: две недели моментов, активный проект на 30 дней, завершённый проект и несколько фильмов.
// Видео — абстрактные анимированные градиенты, сгенерированные FFmpeg (никаких чужих материалов).
//
// Сайт и воркер должны быть запущены (npm run dev). Только для разработки.
//
// Демо-аккаунт: почта и пароль заданы ниже, в DEMO.

import "@/lib/load-env";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addDays, deviceYmd } from "@/lib/dates";
import { ffmpeg, killAllFfmpeg } from "@/worker/ffmpeg";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const DEMO = { name: "Борис", email: "demo@example.com", password: "flash-demo-2026" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookies = new Map<string, string>();

async function call<T = Record<string, unknown>>(
  pathname: string,
  method = "GET",
  body?: unknown,
  raw?: Uint8Array<ArrayBuffer>,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (cookies.size > 0) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (raw) headers["content-type"] = "application/octet-stream";
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

/** Палитры «сцен»: закат, море, лес, утро, вечерний город, поле. */
const SCENES = [
  { name: "sunset", colors: ["0xFFD9A0", "0xF58A5C", "0xC0507A", "0x3B2F63"], note: "Закат на набережной" },
  { name: "sea", colors: ["0xCFF3F0", "0x6EC6CA", "0x2F7F9E", "0x143C5C"], note: "Море сегодня спокойное" },
  { name: "forest", colors: ["0xE4F5C8", "0x9BD26B", "0x4E8F3A", "0x1F4A2A"], note: "Прогулка в лесу" },
  { name: "morning", colors: ["0xFFF4D6", "0xFFD98A", "0xF7B267", "0xA8D5BA"], note: "Утренний кофе" },
  { name: "city", colors: ["0x2B2D52", "0x5B4B8A", "0xE08E79", "0xF9D29D"], note: "Вечерний город" },
  { name: "field", colors: ["0xF7F2C4", "0xD9E88A", "0x8CC66D", "0x6FB7D6"], note: "Дорога через поле" },
];

async function makeClip(dir: string, index: number): Promise<string> {
  const scene = SCENES[index % SCENES.length];
  const portrait = index % 5 !== 3;
  const size = portrait ? "720x1280" : "1280x720";
  const seconds = 10 + (index % 4) * 2;
  const [c0, c1, c2, c3] = scene.colors;
  const file = `clip_${String(index).padStart(2, "0")}.mp4`;
  // Тихий «ветер» и редкий голос-тон: на таком звуке слышно, как музыка отступает.
  const voice = index % 3 === 0 ? `+0.22*gt(sin(2*PI*t/5),0.55)*sin(2*PI*${180 + index * 7}*t)` : "";
  await ffmpeg(
    [
      "-f", "lavfi", "-i", `gradients=s=${size}:r=30:c0=${c0}:c1=${c1}:c2=${c2}:c3=${c3}:n=4:seed=${index + 3}:speed=0.012`,
      "-f", "lavfi", "-i", `anoisesrc=color=brown:amplitude=0.06:sample_rate=48000`,
      "-f", "lavfi", "-i", `aevalsrc='0.0001${voice}':s=48000`,
      "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0,lowpass=f=3200[a]",
      "-map", "0:v", "-map", "[a]",
      "-t", String(seconds),
      "-vf", "noise=alls=4:allf=t,vignette=PI/5",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      file,
    ],
    { cwd: dir },
  );
  return path.join(dir, file);
}

async function upload(file: string, date: string, time: string, note: string, projectIds: string[]): Promise<string | null> {
  const data = await fs.readFile(file);
  const init = await call<{ moment: { id: string; status: string }; chunkBytes: number; error?: string }>("/api/moments", "POST", {
    clientId: `seed${crypto.randomBytes(10).toString("hex")}`,
    recordedAt: new Date(`${date}T${time}:00`).toISOString(),
    localDate: date,
    localTime: time,
    note,
    source: "camera",
    mime: "video/mp4",
    sizeBytes: data.length,
    projectIds,
  });
  if (init.status !== 200) {
    console.log(`   пропуск ${date} ${time}: ${init.data.error}`);
    return null;
  }
  const { moment, chunkBytes } = init.data;
  for (let n = 1; (n - 1) * chunkBytes < data.length; n++) {
    await call(`/api/moments/${moment.id}/parts/${n}`, "PUT", undefined, data.subarray((n - 1) * chunkBytes, n * chunkBytes));
  }
  await call(`/api/moments/${moment.id}/complete`, "POST", {});
  return moment.id;
}

async function waitFilms(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const { data } = await call<{ films: { status: string; title: string }[] }>("/api/films");
    const busy = data.films.filter((f) => f.status === "queued" || f.status === "rendering");
    if (busy.length === 0) return;
    if (i % 5 === 0) console.log(`   монтируется: ${busy.map((f) => f.title).join(", ")}`);
    await sleep(2000);
  }
}

async function main(): Promise<void> {
  const today = deviceYmd();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let auth = await call("/api/auth/login", "POST", { email: DEMO.email, password: DEMO.password, timezone: tz });
  if (auth.status !== 200) auth = await call("/api/auth/register", "POST", { ...DEMO, timezone: tz });
  if (auth.status !== 200) throw new Error(`не удалось войти в демо-аккаунт (HTTP ${auth.status})`);
  console.log(`Демо-аккаунт: ${DEMO.email}`);

  const existing = await call<{ totals: { moments: number } }>(`/api/home?today=${today}`);
  if (existing.data.totals.moments > 0) {
    console.log("В аккаунте уже есть моменты — демо-данные не добавляю.");
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flash-seed-"));
  try {
    console.log("Создаю проекты…");
    const active = await call<{ id: string }>("/api/projects", "POST", {
      title: "30 дней моей жизни",
      description: "Маленький кусочек каждого дня.",
      periodKind: "custom",
      startDate: addDays(today, -17),
      endDate: addDays(today, 12),
      coverPreset: "sunset",
      includeExisting: false,
      today,
    });
    const trip = await call<{ id: string }>("/api/projects", "POST", {
      title: "Наше путешествие",
      description: "Неделя у моря.",
      periodKind: "custom",
      startDate: addDays(today, -13),
      endDate: today,
      coverPreset: "sea",
      includeExisting: false,
      today,
    });

    console.log("Записываю моменты за последние две недели…");
    const times = ["09:20", "14:45", "19:30"];
    let index = 0;
    const ids: string[] = [];
    for (let back = 13; back >= 0; back--) {
      const date = addDays(today, -back);
      // Пара пропущенных дней: проект при этом продолжается.
      if (back === 9 || back === 4) continue;
      const count = back === 0 ? 2 : 1 + ((back * 7) % 3);
      for (let k = 0; k < count; k++) {
        const clip = await makeClip(dir, index);
        const scene = SCENES[index % SCENES.length];
        const projects = [active.data.id, ...(back >= 6 ? [trip.data.id] : [])];
        const id = await upload(clip, date, times[k], k === 0 ? scene.note : "", projects);
        if (id) ids.push(id);
        await fs.rm(clip, { force: true });
        index++;
      }
      process.stdout.write(`   ${date}: ${count}\n`);
    }

    console.log("Жду обработку видео…");
    for (let i = 0; i < 300; i++) {
      const { data } = await call<{ moments: { status: string }[] }>("/api/moments?limit=200");
      if (data.moments.length >= ids.length && data.moments.every((m) => m.status !== "processing")) break;
      await sleep(1500);
    }
    await call(`/api/moments/${ids[2]}`, "PATCH", { favorite: true });
    await call(`/api/moments/${ids[ids.length - 4]}`, "PATCH", { favorite: true });

    console.log("Собираю фильмы…");
    const yesterday = addDays(today, -1);
    await call("/api/films", "POST", { kind: "day", dateFrom: yesterday, dateTo: yesterday, variant: "full", style: "memories", music: "warm-memories" });
    await call("/api/films", "POST", { kind: "custom", dateFrom: addDays(today, -13), dateTo: addDays(today, -7), variant: "highlights", style: "cinematic", music: "dreamy-cinematic" });
    await call(`/api/projects/${trip.data.id}`, "PATCH", { today, action: "complete" });
    await call(`/api/projects/${trip.data.id}/films`, "POST", { variant: "trailer", style: "clean", music: "happy-moments" });
    await waitFilms();
    console.log("Готово. Войдите с демо-аккаунтом из scripts/seed-demo.ts.");
  } finally {
    killAllFfmpeg();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    killAllFfmpeg();
    process.exit(1);
  },
);
