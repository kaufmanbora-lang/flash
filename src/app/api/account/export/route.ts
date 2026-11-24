// Экспорт личного архива: ZIP со всеми исходными видео, готовыми фильмами и описанием в JSON.
// Архив собирается на лету и сразу уходит в ответ — на диске сервера ничего не копится.

import { Readable } from "node:stream";
import yazl from "yazl";
import { q } from "@/lib/db";
import { safeFileName } from "@/lib/dto";
import { storage } from "@/lib/storage";
import type { FilmRow, MomentRow, ProjectRow } from "@/lib/types";
import { contentDisposition } from "@/server/range";
import { route } from "@/server/api";

type LazyZip = yazl.ZipFile & {
  addReadStreamLazy(
    path: string,
    options: { compress?: boolean; mtime?: Date },
    getStream: (cb: (err: Error | null, stream?: Readable) => void) => void,
  ): void;
};

export const GET = route(async ({ user }) => {
  const store = await storage();
  const [moments, films, projects, links] = await Promise.all([
    q<MomentRow>(`SELECT * FROM moments WHERE user_id = $1 AND status = 'ready' ORDER BY recorded_at`, [user.id]),
    q<FilmRow>(`SELECT * FROM films WHERE user_id = $1 AND file_key IS NOT NULL ORDER BY date_from, created_at`, [user.id]),
    q<ProjectRow>(`SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at`, [user.id]),
    q<{ project_id: string; moment_id: string }>(
      `SELECT pm.project_id, pm.moment_id FROM project_moments pm JOIN projects p ON p.id = pm.project_id WHERE p.user_id = $1`,
      [user.id],
    ),
  ]);

  const used = new Set<string>();
  const unique = (base: string, ext: string) => {
    let name = `${base}.${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  };

  const momentFiles = new Map<string, string>();
  for (const m of moments) {
    if (m.original_key) momentFiles.set(m.id, unique(`moments/${m.local_date}/${m.local_time.replace(":", "-")}`, m.ext));
  }
  const filmFiles = new Map<string, string>();
  for (const f of films) {
    filmFiles.set(f.id, unique(`films/${safeFileName(f.title)} — ${f.variant}`, "mp4"));
  }

  const meta = {
    app: "Flash",
    exportedAt: new Date().toISOString(),
    user: { name: user.name, email: user.email, timezone: user.timezone },
    moments: moments.map((m) => ({
      id: m.id,
      file: momentFiles.get(m.id) ?? null,
      recordedAt: m.recorded_at.toISOString(),
      date: m.local_date,
      time: m.local_time,
      note: m.note,
      favorite: m.favorite,
      durationMs: m.duration_ms,
      width: m.width,
      height: m.height,
      source: m.source,
      projects: links.filter((l) => l.moment_id === m.id).map((l) => l.project_id),
    })),
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      startDate: p.start_date,
      endDate: p.end_date,
      status: p.status,
    })),
    films: films.map((f) => ({
      id: f.id,
      file: filmFiles.get(f.id) ?? null,
      title: f.title,
      kind: f.kind,
      variant: f.variant,
      dateFrom: f.date_from,
      dateTo: f.date_to,
      style: f.style_used,
      durationMs: f.duration_ms,
      projectId: f.project_id,
    })),
  };

  const zip = new yazl.ZipFile() as LazyZip;
  zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2), "utf8"), "flash-archive.json");
  // Потоки открываются по одному, когда до файла доходит очередь: тысячи видео не откроются разом.
  for (const m of moments) {
    const name = momentFiles.get(m.id);
    if (!name || !m.original_key) continue;
    const key = m.original_key;
    zip.addReadStreamLazy(name, { compress: false, mtime: m.recorded_at }, (cb) => {
      store.getStream(key).then((s) => cb(null, s), (err) => cb(err as Error));
    });
  }
  for (const f of films) {
    const name = filmFiles.get(f.id);
    if (!name || !f.file_key) continue;
    const key = f.file_key;
    zip.addReadStreamLazy(name, { compress: false, mtime: f.rendered_at ?? f.created_at }, (cb) => {
      store.getStream(key).then((s) => cb(null, s), (err) => cb(err as Error));
    });
  }
  zip.end();

  const out = zip.outputStream as unknown as Readable;
  zip.on("error", (err: Error) => {
    console.error("[export] ошибка сборки архива:", err);
    out.destroy(err);
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(Readable.toWeb(out) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`flash-archive-${stamp}.zip`),
      "Cache-Control": "no-store",
    },
  });
});
