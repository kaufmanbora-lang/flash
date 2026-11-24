// Запуск локального «бэкенда» в браузере: фоновые задачи, восстановление после закрытия приложения.

import { queueAnalysis, queuePendingAnalysis } from "./analyze";
import { refreshCover } from "./covers";
import { recoverInterruptedRenders, runMaintenance } from "./maintenance";
import { requestPersistence } from "./recording";
import { store } from "./store";
import { setBackgroundTasks } from "./tasks";

if (typeof window !== "undefined") {
  setBackgroundTasks({ analyzeMoment: queueAnalysis, refreshCover });
}

let booted: Promise<void> | null = null;

/** Выполняется один раз за запуск приложения. Повторные вызовы возвращают тот же результат. */
export function bootLocal(): Promise<void> {
  booted ??= (async () => {
    await store.ready();
    await recoverInterruptedRenders().catch(() => {});
    queuePendingAnalysis();
    void requestPersistence();
    await runMaintenance().catch(() => {});
  })().catch((err) => {
    booted = null;
    throw err;
  });
  return booted;
}
