// npm run migrate — применяет SQL-миграции из db/migrations.
import "@/lib/load-env";
import { closePool } from "@/lib/db";
import { migrateWithRetry } from "@/lib/migrate";

migrateWithRetry((m) => console.log(`[migrate] ${m}`))
  .then(async () => {
    console.log("[migrate] схема базы актуальна");
    await closePool();
  })
  .catch(async (err) => {
    console.error("[migrate] ошибка:", err);
    await closePool().catch(() => {});
    process.exit(1);
  });
