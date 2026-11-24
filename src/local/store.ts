// Хранилище на устройстве. Всё, что есть во Flash, лежит в IndexedDB этого браузера:
// записи (моменты, проекты, фильмы, профиль) и сами видеофайлы. Сервера нет.
//
// Записи маленькие, поэтому при старте целиком читаются в память — выборки для экранов
// работают по обычным массивам. Файлы (Blob) остаются на диске и читаются по ключу.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CoverPreset, FilmKind, FilmStyleId, FilmVariant, Orientation, PeriodKind, Resolution } from "@/lib/constants";
import type { Ymd } from "@/lib/dates";
import type { PauseSpan, ProjectStatus, ProjectTiming } from "@/lib/projects";
import type { MusicChoice, StyleChoice } from "@/lib/settings";
import type { FilmChapter, FilmOptions, FilmStatus, MomentAnalysis } from "@/lib/types";

export interface MomentRec {
  id: string;
  /** Момент съёмки, ISO. */
  recordedAt: string;
  /** Дата и время по часам устройства в момент съёмки. */
  date: Ymd;
  time: string;
  note: string;
  /** Заметка в нижнем регистре для поиска. */
  noteNorm: string;
  source: "camera" | "upload";
  mime: string;
  ext: string;
  sizeBytes: number;
  posterBytes: number;
  durationMs: number;
  width: number;
  height: number;
  favorite: boolean;
  projectIds: string[];
  /** Профиль громкости и движения по секундам; считается в фоне после сохранения. */
  analysis: MomentAnalysis | null;
  analysisState: "pending" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRec {
  id: string;
  title: string;
  description: string;
  periodKind: PeriodKind;
  startDate: Ymd;
  endDate: Ymd | null;
  status: ProjectStatus;
  pauses: PauseSpan[];
  completedAt: string | null;
  coverKind: "auto" | "preset" | "moment";
  coverPreset: CoverPreset;
  coverMomentId: string | null;
  /** Размер собранной обложки; 0 — обложки из кадров ещё нет. */
  coverBytes: number;
  filmSettings: Partial<FilmOptions>;
  createdAt: string;
  updatedAt: string;
}

export interface FilmRec {
  id: string;
  projectId: string | null;
  kind: FilmKind;
  variant: FilmVariant;
  title: string;
  subtitle: string;
  dateFrom: Ymd;
  dateTo: Ymd;
  style: StyleChoice;
  styleUsed: FilmStyleId | null;
  music: MusicChoice;
  musicUsed: string[];
  musicVolume: number;
  orientation: Orientation;
  resolution: Resolution;
  status: FilmStatus;
  progress: number;
  stage: string;
  error: string | null;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number;
  posterBytes: number;
  momentsCount: number;
  /** Есть готовый файл (даже если сейчас заказана пересборка). */
  hasFile: boolean;
  mime: string;
  chapters: FilmChapter[];
  auto: boolean;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  renderedAt: string | null;
}

export interface ProfileRec {
  name: string;
  timezone: string;
  locale: string;
  /** Настройки как есть; при чтении проходят через resolveSettings. */
  settings: unknown;
  createdAt: string;
}

/** Кусок идущей записи: если приложение закроют во время съёмки, запись можно восстановить. */
export interface RecordingChunk {
  session: string;
  seq: number;
  blob: Blob;
  mime: string;
  startedAt: number;
  facing: "user" | "environment";
  /** Сколько миллисекунд записи прошло, когда пришёл этот кусок. */
  elapsedMs?: number;
}

interface FlashDB extends DBSchema {
  kv: { key: string; value: unknown };
  moments: { key: string; value: MomentRec };
  projects: { key: string; value: ProjectRec };
  films: { key: string; value: FilmRec };
  blobs: { key: string; value: Blob };
  chunks: { key: [string, number]; value: RecordingChunk; indexes: { session: string } };
}

const DB_NAME = "flash-diary";
const DB_VERSION = 1;

/** Ключи файлов. */
export const blobKey = {
  momentVideo: (id: string) => `m/${id}/video`,
  momentPoster: (id: string) => `m/${id}/poster`,
  momentPrefix: (id: string) => `m/${id}/`,
  filmVideo: (id: string) => `f/${id}/video`,
  filmPoster: (id: string) => `f/${id}/poster`,
  filmPrefix: (id: string) => `f/${id}/`,
  projectCover: (id: string) => `p/${id}/cover`,
  projectPrefix: (id: string) => `p/${id}/`,
};

export const projectTiming = (p: ProjectRec): ProjectTiming => ({
  start_date: p.startDate,
  end_date: p.endDate,
  status: p.status,
  pauses: p.pauses,
});

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Старые браузеры: достаточно случайный идентификатор из getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Браузеру не хватило места на устройстве (или он не дал приложению больше). */
export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

type Listener = () => void;

class Store {
  readonly moments = new Map<string, MomentRec>();
  readonly projects = new Map<string, ProjectRec>();
  readonly films = new Map<string, FilmRec>();
  profile: ProfileRec | null = null;

  private dbPromise: Promise<IDBPDatabase<FlashDB>> | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private urls = new Map<string, string>();

  private db(): Promise<IDBPDatabase<FlashDB>> {
    this.dbPromise ??= openDB<FlashDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore("kv");
        database.createObjectStore("moments", { keyPath: "id" });
        database.createObjectStore("projects", { keyPath: "id" });
        database.createObjectStore("films", { keyPath: "id" });
        database.createObjectStore("blobs");
        const chunks = database.createObjectStore("chunks", { keyPath: ["session", "seq"] });
        chunks.createIndex("session", "session");
      },
    });
    this.dbPromise.catch(() => (this.dbPromise = null));
    return this.dbPromise;
  }

  /** Читает записи в память. Вызывается перед любой работой с данными. */
  ready(): Promise<void> {
    this.loading ??= this.load().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const database = await this.db();
    const [moments, projects, films, profile] = await Promise.all([
      database.getAll("moments"),
      database.getAll("projects"),
      database.getAll("films"),
      database.get("kv", "profile"),
    ]);
    this.moments.clear();
    this.projects.clear();
    this.films.clear();
    for (const m of moments) this.moments.set(m.id, m);
    for (const p of projects) this.projects.set(p.id, p);
    for (const f of films) this.films.set(f.id, f);
    this.profile = (profile as ProfileRec | undefined) ?? null;

    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      // Вторая вкладка приложения изменила данные — перечитываем их и здесь.
      this.channel = new BroadcastChannel("flash-diary");
      // В Node (тесты) открытый канал не должен удерживать процесс.
      (this.channel as unknown as { unref?: () => void }).unref?.();
      this.channel.onmessage = () => {
        this.loading = this.load().then(() => this.emit(false));
      };
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitQueued = false;
  private emitBroadcast = false;

  /** Несколько изменений подряд дают одно уведомление — интерфейс перечитывает данные один раз. */
  private emit(broadcast = true): void {
    this.emitBroadcast ||= broadcast;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      const toOthers = this.emitBroadcast;
      this.emitBroadcast = false;
      for (const fn of this.listeners) fn();
      if (toOthers) {
        try {
          this.channel?.postMessage("changed");
        } catch {
          /* канал закрыт — не критично */
        }
      }
    });
  }

  // ── Профиль и произвольные значения ────────────────────────

  async saveProfile(profile: ProfileRec): Promise<void> {
    await (await this.db()).put("kv", profile, "profile");
    this.profile = profile;
    this.emit();
  }

  async getValue<T>(key: string): Promise<T | undefined> {
    return (await (await this.db()).get("kv", key)) as T | undefined;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    await (await this.db()).put("kv", value, key);
  }

  // ── Записи ─────────────────────────────────────────────────

  /**
   * Запись и её файлы пишутся одной транзакцией: момент без видео (или видео без момента) не появится.
   * При нехватке места наружу уходит исходная ошибка браузера (QuotaExceededError), а не безликий «abort».
   */
  private async write(kind: "moments" | "projects" | "films", rec: MomentRec | ProjectRec | FilmRec, files?: Record<string, Blob>): Promise<void> {
    const database = await this.db();
    const tx = database.transaction([kind, "blobs"], "readwrite");
    try {
      for (const [key, blob] of Object.entries(files ?? {})) await tx.objectStore("blobs").put(blob, key);
      await (tx.objectStore(kind) as unknown as { put(value: unknown): Promise<unknown> }).put(rec);
      await tx.done;
    } catch (err) {
      tx.done.catch(() => {});
      try {
        tx.abort();
      } catch {
        /* транзакция уже закрыта */
      }
      throw tx.error ?? err;
    }
    for (const key of Object.keys(files ?? {})) this.forgetUrl(key);
  }

  async putMoment(rec: MomentRec, files?: Record<string, Blob>): Promise<void> {
    await this.write("moments", rec, files);
    this.moments.set(rec.id, rec);
    this.emit();
  }

  async removeMoment(id: string): Promise<void> {
    const database = await this.db();
    await database.delete("moments", id);
    await this.deleteBlobs(blobKey.momentPrefix(id));
    this.moments.delete(id);
    this.emit();
  }

  async putProject(rec: ProjectRec, files?: Record<string, Blob>): Promise<void> {
    await this.write("projects", rec, files);
    this.projects.set(rec.id, rec);
    this.emit();
  }

  async removeProject(id: string): Promise<void> {
    const database = await this.db();
    await database.delete("projects", id);
    await this.deleteBlobs(blobKey.projectPrefix(id));
    this.projects.delete(id);
    this.emit();
  }

  async putFilm(rec: FilmRec, files?: Record<string, Blob>): Promise<void> {
    await this.write("films", rec, files);
    this.films.set(rec.id, rec);
    this.emit();
  }

  async removeFilm(id: string): Promise<void> {
    const database = await this.db();
    await database.delete("films", id);
    await this.deleteBlobs(blobKey.filmPrefix(id));
    this.films.delete(id);
    this.emit();
  }

  // ── Файлы ──────────────────────────────────────────────────

  async getBlob(key: string): Promise<Blob | undefined> {
    return (await this.db()).get("blobs", key);
  }

  async putBlob(key: string, blob: Blob): Promise<void> {
    await (await this.db()).put("blobs", blob, key);
    this.forgetUrl(key);
  }

  async deleteBlob(key: string): Promise<void> {
    await (await this.db()).delete("blobs", key);
    this.forgetUrl(key);
  }

  async deleteBlobs(prefix: string): Promise<void> {
    const database = await this.db();
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const keys = await database.getAllKeys("blobs", range);
    await database.delete("blobs", range);
    for (const key of keys) this.forgetUrl(key);
  }

  async blobKeys(): Promise<string[]> {
    return (await this.db()).getAllKeys("blobs");
  }

  /**
   * Адрес файла для <video>/<img>. Создаётся один раз и живёт, пока файл не заменят или не удалят:
   * браузер читает данные с диска по мере надобности, в память видео целиком не грузится.
   */
  async url(key: string): Promise<string | null> {
    const cached = this.urls.get(key);
    if (cached) return cached;
    const blob = await this.getBlob(key);
    if (!blob) return null;
    const again = this.urls.get(key);
    if (again) return again;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  private forgetUrl(key: string): void {
    const url = this.urls.get(key);
    if (!url) return;
    this.urls.delete(key);
    // Адрес может ещё использоваться открытым плеером — отзываем чуть позже.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  // ── Куски идущей записи ────────────────────────────────────

  async putChunk(chunk: RecordingChunk): Promise<void> {
    await (await this.db()).put("chunks", chunk);
  }

  async clearChunks(session?: string): Promise<void> {
    const database = await this.db();
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

  async allChunks(): Promise<RecordingChunk[]> {
    return (await this.db()).getAll("chunks");
  }

  // ── Полная очистка ─────────────────────────────────────────

  /** Удаляет все данные дневника с этого устройства. Профиль (имя) по желанию остаётся. */
  async wipe(keepProfile: boolean): Promise<void> {
    const database = await this.db();
    const tx = database.transaction(["moments", "projects", "films", "blobs", "chunks", "kv"], "readwrite");
    await Promise.all([
      tx.objectStore("moments").clear(),
      tx.objectStore("projects").clear(),
      tx.objectStore("films").clear(),
      tx.objectStore("blobs").clear(),
      tx.objectStore("chunks").clear(),
    ]);
    const profile = keepProfile ? this.profile : null;
    await tx.objectStore("kv").clear();
    if (profile) await tx.objectStore("kv").put(profile, "profile");
    await tx.done;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.moments.clear();
    this.projects.clear();
    this.films.clear();
    this.profile = profile;
    this.emit();
  }

  /** Только для тестов: забыть соединение и содержимое памяти. */
  async resetForTests(): Promise<void> {
    const database = await this.dbPromise?.catch(() => null);
    database?.close();
    this.channel?.close();
    this.channel = null;
    this.dbPromise = null;
    this.loading = null;
    this.moments.clear();
    this.projects.clear();
    this.films.clear();
    this.profile = null;
    this.urls.clear();
  }
}

export const store = new Store();
