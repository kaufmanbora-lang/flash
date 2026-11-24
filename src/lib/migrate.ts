import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./db";

const LOCK_KEY = 4815162342;

/** Применяет ещё не выполненные SQL-миграции из db/migrations. Безопасно вызывать из нескольких процессов. */
export async function migrate(log: (msg: string) => void = () => {}): Promise<string[]> {
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool().connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Миграция ${file} не применилась: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`миграция применена: ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

/** Ждёт базу и применяет миграции; полезно при одновременном старте сервисов. */
export async function migrateWithRetry(log: (msg: string) => void = console.log, attempts = 40): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await migrate(log);
      return;
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      // Ошибка в самой миграции — повторять бессмысленно.
      if (msg.startsWith("Миграция ")) throw err;
      if (i === 0) log("жду базу данных…");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}
