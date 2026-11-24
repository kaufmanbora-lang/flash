// Защита записи от прерывания: куски идущей съёмки складываются в хранилище, и если приложение
// закрыли или выгрузили посреди записи, её можно восстановить при следующем запуске.

import { store, type RecordingChunk } from "./store";

export type { RecordingChunk };

export const putChunk = (chunk: RecordingChunk): Promise<void> => store.putChunk(chunk);
export const clearChunks = (session?: string): Promise<void> => store.clearChunks(session);

export interface InterruptedRecording {
  session: string;
  blob: Blob;
  mime: string;
  startedAt: number;
  /** Примерная длительность: время записи на момент последнего сохранённого куска. */
  approxDurationMs: number;
}

/** Запись, которая оборвалась и осталась на устройстве. */
export async function findInterrupted(): Promise<InterruptedRecording | null> {
  await store.ready();
  const all = await store.allChunks();
  if (all.length === 0) return null;
  const sessions = new Map<string, RecordingChunk[]>();
  for (const c of all) {
    const list = sessions.get(c.session) ?? [];
    list.push(c);
    sessions.set(c.session, list);
  }
  // Берём самую свежую сессию.
  const [session, chunks] = [...sessions.entries()].sort((a, b) => b[1][0].startedAt - a[1][0].startedAt)[0];
  chunks.sort((a, b) => a.seq - b.seq);
  const mime = chunks[0].mime;
  return {
    session,
    blob: new Blob(chunks.map((c) => c.blob), { type: mime }),
    mime,
    startedAt: chunks[0].startedAt,
    // Браузеры отдают куски не строго раз в секунду, поэтому длительность берём из отметки времени куска.
    approxDurationMs: Math.max(0, ...chunks.map((c) => c.elapsedMs ?? 0)) || chunks.length * 1000,
  };
}

/** Сколько свободного места осталось у приложения (если браузер сообщает). */
export async function freeSpaceBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota === undefined || est.usage === undefined) return null;
    return Math.max(0, est.quota - est.usage);
  } catch {
    return null;
  }
}

/**
 * Просит браузер не вычищать данные приложения при нехватке места.
 * Дневник хранится только здесь, поэтому это важно: без такого обещания браузер вправе удалить данные сайта.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
