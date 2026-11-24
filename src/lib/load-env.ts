// Подхватывает .env.local и .env для процессов вне Next.js (воркер, скрипты).
// Next.js загружает их сам. Уже заданные переменные не перезаписываются.
import fs from "node:fs";
import path from "node:path";

for (const file of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), file);
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch (err) {
      console.warn(`[env] не удалось прочитать ${file}:`, (err as Error).message);
    }
  }
}
