import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "@/lib/env";

function baseDir(): string {
  return env.workDir ?? path.join(os.tmpdir(), "flash-work");
}

/** Отдельная временная папка на задачу; ffmpeg запускается с ней как рабочим каталогом. */
export async function makeWorkDir(prefix: string): Promise<string> {
  const base = baseDir();
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}

export async function removeWorkDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}

/** При старте воркера убирает папки, оставшиеся от аварийно прерванных задач. */
export async function cleanupWorkDirs(olderThanMs = 6 * 3600_000): Promise<void> {
  const base = baseDir();
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(base, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > olderThanMs) await removeWorkDir(full);
  }
}

/** Ошибка, после которой повторять задачу бессмысленно (например, видео короче 10 секунд). */
export class PermanentError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PermanentError";
  }
}
