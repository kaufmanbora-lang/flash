// Очередь фоновых задач поверх PostgreSQL (FOR UPDATE SKIP LOCKED).
// Две полосы: media — быстрые задачи (обработка момента, обложки), film — монтаж.
// Так долгий рендер фильма не задерживает появление новых моментов в приложении.

import { exec, q, q1 } from "./db";

export type JobLane = "media" | "film";

export type JobType = "process_moment" | "render_film" | "project_cover";

export interface JobRow {
  id: number;
  type: JobType;
  lane: JobLane;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

const LANE_OF: Record<JobType, JobLane> = {
  process_moment: "media",
  project_cover: "media",
  render_film: "film",
};

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { delaySec?: number; maxAttempts?: number } = {},
): Promise<number> {
  const row = await q1<{ id: number }>(
    `INSERT INTO jobs (type, lane, payload, run_at, max_attempts)
     VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4), $5)
     RETURNING id`,
    [type, LANE_OF[type], JSON.stringify(payload), opts.delaySec ?? 0, opts.maxAttempts ?? 3],
  );
  return row!.id;
}

/** Ставит задачу, только если такой же (тип + payload) ещё нет в очереди. */
export async function enqueueUnique(type: JobType, payload: Record<string, unknown>, delaySec = 0): Promise<void> {
  const existing = await q1(
    `SELECT id FROM jobs WHERE type = $1 AND status = 'queued' AND payload = $2::jsonb LIMIT 1`,
    [type, JSON.stringify(payload)],
  );
  if (!existing) await enqueue(type, payload, { delaySec });
}

export async function claimJob(lane: JobLane, workerId: string): Promise<JobRow | null> {
  return q1<JobRow>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE lane = $1 AND status = 'queued' AND run_at <= now()
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, type, lane, payload, status, attempts, max_attempts, last_error`,
    [lane, workerId],
  );
}

export async function heartbeat(jobId: number): Promise<void> {
  await exec(`UPDATE jobs SET locked_at = now() WHERE id = $1 AND status = 'running'`, [jobId]);
}

export async function completeJob(jobId: number): Promise<void> {
  await exec(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [jobId]);
}

/** Возвращает true, если задача будет повторена. */
export async function failJob(job: JobRow, error: string, retryable = true): Promise<boolean> {
  const willRetry = retryable && job.attempts < job.max_attempts;
  if (willRetry) {
    const delay = Math.min(300, 15 * 2 ** (job.attempts - 1));
    await exec(
      `UPDATE jobs SET status = 'queued', run_at = now() + make_interval(secs => $2), last_error = $3,
              locked_at = NULL, locked_by = NULL
       WHERE id = $1`,
      [job.id, delay, error.slice(0, 4000)],
    );
  } else {
    await exec(`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1`, [
      job.id,
      error.slice(0, 4000),
    ]);
  }
  return willRetry;
}

/** Задачи, чей воркер перестал подавать признаки жизни, возвращаются в очередь. */
export async function requeueStaleJobs(staleAfterSec = 180): Promise<JobRow[]> {
  return q<JobRow>(
    `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            locked_at = NULL, locked_by = NULL,
            last_error = COALESCE(last_error, 'Воркер был остановлен во время выполнения'),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)
     RETURNING id, type, lane, payload, status, attempts, max_attempts, last_error`,
    [staleAfterSec],
  );
}

export async function cleanupJobs(): Promise<void> {
  await exec(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - interval '14 days'`);
}
