// Локальное хранилище на устройстве (IndexedDB): черновики моментов и «хвосты» записи.
// Видео сначала сохраняется здесь и только потом уходит на сервер — запись не теряется
// ни без сети, ни при закрытии приложения.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Ymd } from "@/lib/dates";

export type DraftState =
  /** Ждёт своей очереди. */
  | "queued"
  | "uploading"
  /** Временная ошибка (нет сети) — загрузка повторится сама. */
  | "error"
  /** Сервер отказал окончательно (лимит дня, хранилище заполнено). */
  | "failed";

export interface Draft {
  clientId: string;
  blob: Blob;
  mime: string;
  size: number;
  recordedAt: string;
  localDate: Ymd;
  localTime: string;
  note: string;
  projectIds: string[];
  /** Проекты не выбирались (восстановленная запись): сервер добавит момент во все идущие проекты. */
  autoProjects?: boolean;
  source: "camera" | "upload";
  durationMs: number;
  width: number;
  height: number;
  poster: Blob | null;
  state: DraftState;
  /** Код ошибки сервера или 'network'. */
  error: string | null;
  momentId: string | null;
  uploadedBytes: number;
  attempts: number;
  createdAt: number;
}

/** Черновик без тяжёлых данных — для списков в интерфейсе. */
export type DraftInfo = Omit<Draft, "blob" | "poster"> & { posterUrl: string | null };

export interface RecordingChunk {
  session: string;
  seq: number;
  blob: Blob;
  mime: string;
  startedAt: number;
  facing: "user" | "environment";
  /**
   * Сколько миллисекунд записи прошло, когда пришёл этот кусок. Браузеры отдают куски не строго
   * раз в секунду (Chrome с MP4 — раз в несколько секунд), поэтому число кусков длительность не показывает.
   */
  elapsedMs?: number;
}

interface FlashDB extends DBSchema {
  drafts: { key: string; value: Draft };
  chunks: { key: [string, number]; value: RecordingChunk; indexes: { session: string } };
}

let dbPromise: Promise<IDBPDatabase<FlashDB>> | null = null;

function db(): Promise<IDBPDatabase<FlashDB>> {
  dbPromise ??= openDB<FlashDB>("flash", 1, {
    upgrade(database) {
      database.createObjectStore("drafts", { keyPath: "clientId" });
      const chunks = database.createObjectStore("chunks", { keyPath: ["session", "seq"] });
      chunks.createIndex("session", "session");
    },
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

export async function putDraft(draft: Draft): Promise<void> {
  await (await db()).put("drafts", draft);
}

export async function getDraft(clientId: string): Promise<Draft | undefined> {
  return (await db()).get("drafts", clientId);
}

export async function patchDraft(clientId: string, patch: Partial<Draft>): Promise<void> {
  const database = await db();
  const tx = database.transaction("drafts", "readwrite");
  const current = await tx.store.get(clientId);
  if (current) await tx.store.put({ ...current, ...patch });
  await tx.done;
}

export async function deleteDraft(clientId: string): Promise<void> {
  await (await db()).delete("drafts", clientId);
}

export async function allDrafts(): Promise<Draft[]> {
  const list = await (await db()).getAll("drafts");
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

// ── Куски идущей записи (защита от прерывания) ───────────────

export async function putChunk(chunk: RecordingChunk): Promise<void> {
  await (await db()).put("chunks", chunk);
}

export async function clearChunks(session?: string): Promise<void> {
  const database = await db();
  if (!session) {
    await database.clear("chunks");
    return;
  }
  const tx = database.transaction("chunks", "readwrite");
  let cursor = await tx.store.index("session").openCursor(session);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export interface InterruptedRecording {
  session: string;
  blob: Blob;
  mime: string;
  startedAt: number;
  /** Примерная длительность: время записи на момент последнего сохранённого куска. */
  approxDurationMs: number;
}

/** Запись, которая оборвалась (приложение закрыли или выгрузили) и осталась на устройстве. */
export async function findInterrupted(): Promise<InterruptedRecording | null> {
  const all = await (await db()).getAll("chunks");
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
    // У старых записей отметки времени нет — тогда грубая оценка «кусок в секунду».
    approxDurationMs: Math.max(0, ...chunks.map((c) => c.elapsedMs ?? 0)) || chunks.length * 1000,
  };
}

/** Сколько свободного места осталось на устройстве (если браузер сообщает). */
export async function freeSpaceBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota === undefined || est.usage === undefined) return null;
    return Math.max(0, est.quota - est.usage);
  } catch {
    return null;
  }
}

/** Просит браузер не вычищать данные приложения при нехватке места. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* не поддерживается */
  }
}
