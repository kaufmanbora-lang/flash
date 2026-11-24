// Выполняется один раз при старте сервера Next.js: применяет миграции базы.
// Воркер делает то же самое при своём запуске; блокировка в базе исключает гонку.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateWithRetry } = await import("@/lib/migrate");
  migrateWithRetry((message) => console.log(`[web] ${message}`)).catch((err) => {
    console.error("[web] не удалось применить миграции:", err);
  });
}
