// Резервная копия дневника: ZIP со всеми видео, фильмами и описанием в JSON — и восстановление из неё.
// Дневник хранится только на устройстве, поэтому копия — единственный способ перенести его на другой
// телефон или пережить очистку данных браузера.

import { safeName } from "@/lib/names";
import { blobKey, store, type FilmRec, type MomentRec, type ProfileRec, type ProjectRec } from "./store";
import { ZipBuilder, readZip } from "./zip";

const MANIFEST = "flash.json";
const FORMAT = 2;

interface Manifest {
  app: "Flash";
  format: number;
  exportedAt: string;
  profile: ProfileRec | null;
  moments: (MomentRec & { file: string | null; posterFile: string | null })[];
  projects: (ProjectRec & { coverFile: string | null })[];
  films: (FilmRec & { file: string | null; posterFile: string | null })[];
}

export interface BackupProgress {
  doneBytes: number;
  totalBytes: number;
}

/** Собирает архив. Файлы не копируются в память: архив ссылается на них, а браузер читает их при сохранении. */
export async function exportBackup(onProgress?: (p: BackupProgress) => void): Promise<{ blob: Blob; fileName: string }> {
  await store.ready();
  const zip = new ZipBuilder();
  const moments = [...store.moments.values()].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
  const films = [...store.films.values()].filter((f) => f.hasFile).sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1));
  const projects = [...store.projects.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const totalBytes =
    moments.reduce((s, m) => s + m.sizeBytes + m.posterBytes, 0) +
    films.reduce((s, f) => s + f.sizeBytes + f.posterBytes, 0) +
    projects.reduce((s, p) => s + p.coverBytes, 0);
  let doneBytes = 0;
  const tick = (n: number) => {
    doneBytes += n;
    onProgress?.({ doneBytes, totalBytes });
  };
  const manifest: Manifest = {
    app: "Flash",
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    profile: store.profile,
    moments: [],
    projects: [],
    films: [],
  };

  const addFile = async (key: string, path: string, modified: Date): Promise<string | null> => {
    const blob = await store.getBlob(key);
    if (!blob) return null;
    await zip.add(path, blob, modified, tick);
    return path;
  };

  for (const m of moments) {
    const when = new Date(m.recordedAt);
    const file = await addFile(blobKey.momentVideo(m.id), zip.uniqueName(`moments/${m.date}/${m.time.replace(":", "-")}`, m.ext), when);
    const posterFile = await addFile(blobKey.momentPoster(m.id), `posters/m-${m.id}.jpg`, when);
    manifest.moments.push({ ...m, file, posterFile });
  }
  for (const f of films) {
    const when = new Date(f.renderedAt ?? f.createdAt);
    const ext = f.mime.includes("webm") ? "webm" : "mp4";
    const file = await addFile(blobKey.filmVideo(f.id), zip.uniqueName(`films/${safeName(f.title)} — ${f.variant}`, ext), when);
    const posterFile = await addFile(blobKey.filmPoster(f.id), `posters/f-${f.id}.jpg`, when);
    manifest.films.push({ ...f, file, posterFile });
  }
  for (const p of projects) {
    const coverFile = p.coverBytes > 0 ? await addFile(blobKey.projectCover(p.id), `covers/p-${p.id}.jpg`, new Date(p.updatedAt)) : null;
    manifest.projects.push({ ...p, coverFile });
  }

  await zip.add(MANIFEST, new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }), new Date());
  return { blob: zip.finish(), fileName: `flash-archive-${new Date().toISOString().slice(0, 10)}.zip` };
}

export interface RestoreResult {
  moments: number;
  films: number;
  projects: number;
  /** Сколько записей пропущено, потому что они уже есть в дневнике. */
  skipped: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Восстанавливает дневник из архива. Ничего не удаляет и не перезаписывает:
 * добавляются только те моменты, проекты и фильмы, которых на устройстве ещё нет.
 */
export async function importBackup(file: Blob, onProgress?: (p: BackupProgress) => void): Promise<RestoreResult> {
  await store.ready();
  const entries = new Map((await readZip(file)).map((e) => [e.path, e]));
  const manifestEntry = entries.get(MANIFEST);
  if (!manifestEntry) throw new Error("not_flash_archive");
  const manifest = JSON.parse(await (await manifestEntry.blob()).text()) as Partial<Manifest>;
  if (manifest.app !== "Flash" || !Array.isArray(manifest.moments)) throw new Error("not_flash_archive");

  const totalBytes = [...entries.values()].reduce((s, e) => s + e.size, 0);
  let doneBytes = 0;
  const read = async (path: string | null | undefined, type: string): Promise<Blob | null> => {
    const entry = path ? entries.get(path) : undefined;
    if (!entry) return null;
    const blob = await entry.blob();
    doneBytes += entry.size;
    onProgress?.({ doneBytes, totalBytes });
    // Срез архива не знает своего типа — без него <video> в Safari файл не откроет.
    return blob.slice(0, blob.size, type);
  };

  const result: RestoreResult = { moments: 0, films: 0, projects: 0, skipped: 0 };

  for (const raw of manifest.projects ?? []) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    if (store.projects.has(raw.id)) {
      result.skipped++;
      continue;
    }
    const { coverFile, ...rec } = raw as unknown as ProjectRec & { coverFile: string | null };
    const cover = await read(coverFile, "image/jpeg");
    await store.putProject({ ...rec, coverBytes: cover?.size ?? 0 }, cover ? { [blobKey.projectCover(rec.id)]: cover } : undefined);
    result.projects++;
  }

  for (const raw of manifest.moments) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    if (store.moments.has(raw.id)) {
      result.skipped++;
      continue;
    }
    const { file: videoFile, posterFile, ...rec } = raw as unknown as MomentRec & { file: string | null; posterFile: string | null };
    const video = await read(videoFile, rec.mime || "video/mp4");
    if (!video) continue;
    const poster = await read(posterFile, "image/jpeg");
    const files: Record<string, Blob> = { [blobKey.momentVideo(rec.id)]: video };
    if (poster) files[blobKey.momentPoster(rec.id)] = poster;
    await store.putMoment(
      {
        ...rec,
        sizeBytes: video.size,
        posterBytes: poster?.size ?? 0,
        // Связи с проектами, которых нет ни в архиве, ни на устройстве, не восстанавливаем.
        projectIds: (rec.projectIds ?? []).filter((id) => store.projects.has(id)),
      },
      files,
    );
    result.moments++;
  }

  for (const raw of manifest.films ?? []) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    if (store.films.has(raw.id)) {
      result.skipped++;
      continue;
    }
    const { file: videoFile, posterFile, ...rec } = raw as unknown as FilmRec & { file: string | null; posterFile: string | null };
    const video = await read(videoFile, rec.mime || "video/mp4");
    if (!video) continue;
    const poster = await read(posterFile, "image/jpeg");
    const files: Record<string, Blob> = { [blobKey.filmVideo(rec.id)]: video };
    if (poster) files[blobKey.filmPoster(rec.id)] = poster;
    await store.putFilm(
      {
        ...rec,
        status: "ready",
        progress: 100,
        stage: "",
        error: null,
        hasFile: true,
        sizeBytes: video.size,
        posterBytes: poster?.size ?? 0,
        projectId: rec.projectId && store.projects.has(rec.projectId) ? rec.projectId : null,
      },
      files,
    );
    result.films++;
  }

  if (!store.profile && isRecord(manifest.profile) && typeof manifest.profile.name === "string") {
    await store.saveProfile(manifest.profile as unknown as ProfileRec);
  }
  return result;
}

/** Удаляет дневник с этого устройства. Имя и настройки по желанию остаются. */
export async function wipeDiary(keepProfile: boolean): Promise<void> {
  await store.ready();
  await store.wipe(keepProfile);
}
