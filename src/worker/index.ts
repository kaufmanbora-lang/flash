// Воркер Flash: отдельный долгоживущий процесс для фоновой работы.
//   • полоса media — обработка загруженных моментов и обложки проектов;
//   • полоса film  — монтаж фильмов (FFmpeg);
//   • планировщик  — напоминания, фильм дня, завершение проектов.
// Запуск: npm run start:worker (или dev:worker). Не предназначен для serverless-функций.

import "@/lib/load-env";
import http from "node:http";
import os from "node:os";
import { closePool, exec } from "@/lib/db";
import { env } from "@/lib/env";
import { migrateWithRetry } from "@/lib/migrate";
import { loadMusicLibrary } from "@/lib/music-library";
import { getVapid } from "@/lib/push";
import {
  claimJob,
  completeJob,
  failJob,
  heartbeat,
  requeueStaleJobs,
  type JobLane,
  type JobRow,
} from "@/lib/queue";
import { storage } from "@/lib/storage";
import { ensureMusicLibrary } from "@/music/generate";
import { generateProjectCover } from "./cover";
import { availableFilters, ffmpegVersion, ffprobePath, killAllFfmpeg } from "./ffmpeg";
import { failMoment, processMoment } from "./process-moment";
import { failFilm, renderFilm, SupersededError } from "./render-film";
import { maintenanceTick, schedulerTick } from "./scheduler";
import { ensureFonts } from "./titles";
import { cleanupWorkDirs, PermanentError } from "./workdir";

const workerId = `${os.hostname()}:${process.pid}`;
const log = (msg: string) => console.log(`[worker] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
const state = {
  startedAt: new Date().toISOString(),
  ffmpeg: "",
  music: 0,
  lanes: { media: "idle", film: "idle" } as Record<JobLane, string>,
  lastTick: "",
  jobsDone: 0,
  jobsFailed: 0,
};

/** Что делать, когда задача окончательно не удалась. */
async function onFinalFailure(job: JobRow, code: string): Promise<void> {
  if (job.type === "process_moment") {
    await failMoment(String(job.payload.momentId), code);
  } else if (job.type === "render_film") {
    await failFilm(String(job.payload.filmId), Number(job.payload.revision), code);
  }
}

async function handle(job: JobRow): Promise<void> {
  const beat = setInterval(() => void heartbeat(job.id).catch(() => {}), 20_000);
  const t0 = Date.now();
  try {
    switch (job.type) {
      case "process_moment":
        await processMoment(String(job.payload.momentId));
        break;
      case "render_film":
        await renderFilm(String(job.payload.filmId), Number(job.payload.revision), () => heartbeat(job.id));
        break;
      case "project_cover":
        await generateProjectCover(String(job.payload.projectId));
        break;
      default:
        throw new PermanentError("unknown_job");
    }
    await completeJob(job.id);
    state.jobsDone++;
    log(`${job.type} #${job.id} готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  } catch (err) {
    if (err instanceof SupersededError) {
      await completeJob(job.id);
      log(`${job.type} #${job.id} отменено: запрошена новая сборка`);
      return;
    }
    if (stopping) return; // процесс останавливается — задача вернётся в очередь
    const permanent = err instanceof PermanentError;
    const message = (err as Error).message ?? String(err);
    const willRetry = await failJob(job, message, !permanent);
    console.error(`[worker] ${job.type} #${job.id} ошибка${willRetry ? " (будет повтор)" : ""}:\n${message}`);
    if (!willRetry) {
      state.jobsFailed++;
      const code = permanent ? (err as PermanentError).code : job.type === "render_film" ? "render_failed" : "processing_failed";
      await onFinalFailure(job, code).catch((e) => console.error("[worker] не удалось записать ошибку:", e));
    }
  } finally {
    clearInterval(beat);
  }
}

async function lane(name: JobLane, ready: Promise<unknown>): Promise<void> {
  await ready.catch(() => {});
  while (!stopping) {
    let job: JobRow | null = null;
    try {
      job = await claimJob(name, workerId);
    } catch (err) {
      console.error(`[worker] очередь ${name} недоступна:`, (err as Error).message);
      await sleep(5000);
      continue;
    }
    if (!job) {
      state.lanes[name] = "idle";
      await sleep(1000);
      continue;
    }
    state.lanes[name] = `${job.type} #${job.id}`;
    await handle(job);
  }
}

async function loop(name: string, everyMs: number, fn: () => Promise<void>, initialDelayMs = 0): Promise<void> {
  await sleep(initialDelayMs);
  while (!stopping) {
    try {
      await fn();
    } catch (err) {
      console.error(`[worker] ${name}:`, err);
    }
    for (let waited = 0; waited < everyMs && !stopping; waited += 500) await sleep(500);
  }
}

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, workerId, ...state }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.on("error", (err) => console.warn(`[worker] health-сервер не запущен: ${(err as Error).message}`));
  server.listen(env.workerPort);
  return server;
}

async function main(): Promise<void> {
  log(`запуск (${workerId})`);
  await migrateWithRetry((m) => log(m));
  const store = await storage();
  log(`хранилище: ${store.name}`);

  state.ffmpeg = await ffmpegVersion();
  await ffprobePath();
  const filters = await availableFilters();
  const missing = ["xfade", "acrossfade", "sidechaincompress", "gblur", "zoompan", "tpad", "amix"].filter(
    (f) => !filters.has(f),
  );
  if (missing.length) throw new Error(`В этой сборке FFmpeg нет нужных фильтров: ${missing.join(", ")}`);
  log(`${state.ffmpeg}${filters.has("zscale") ? "" : " (без zscale: HDR-видео не будет приводиться к SDR)"}`);

  ensureFonts();
  await getVapid();
  await cleanupWorkDirs();

  // Задачи, оставшиеся от прошлого запуска этого воркера, сразу возвращаем в очередь.
  await exec(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0)
     WHERE status = 'running' AND locked_by = $1`,
    [workerId],
  );

  // Музыка создаётся один раз (оригинальные композиции, синтезируются кодом).
  const music = ensureMusicLibrary((m) => log(m))
    .then(async () => {
      state.music = (await loadMusicLibrary(true)).length;
      log(`музыкальная библиотека: ${state.music} композиций`);
    })
    .catch((err) => console.error("[worker] музыка не создана, фильмы будут без неё:", err));

  const health = startHealthServer();
  log(`готов к работе, health: http://localhost:${env.workerPort}/health`);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`остановка (${signal})…`);
    killAllFfmpeg();
    health.close();
    await exec(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0)
       WHERE status = 'running' AND locked_by = $1`,
      [workerId],
    ).catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await Promise.all([
    lane("media", Promise.resolve()),
    // Монтаж ждёт музыку, чтобы первый фильм не вышел без неё.
    lane("film", music),
    loop("планировщик", 30_000, async () => {
      await schedulerTick();
      state.lastTick = new Date().toISOString();
    }, 3000),
    loop("обслуживание", 3_600_000, maintenanceTick, 20_000),
    loop("зависшие задачи", 60_000, async () => {
      for (const job of await requeueStaleJobs(180)) {
        if (job.status === "failed") {
          await onFinalFailure(job, job.type === "render_film" ? "render_failed" : "processing_failed");
        }
      }
    }, 10_000),
  ]);
}

main().catch((err) => {
  console.error("[worker] критическая ошибка:", err);
  process.exit(1);
});
