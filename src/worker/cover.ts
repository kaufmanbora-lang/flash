// Обложка проекта: автоматически собирается из кадров записанных моментов.

import path from "node:path";
import { exec, q, q1 } from "@/lib/db";
import { keys, storage } from "@/lib/storage";
import type { ProjectRow } from "@/lib/types";
import { renderCover } from "./titles";
import { makeWorkDir, removeWorkDir } from "./workdir";

export async function generateProjectCover(projectId: string): Promise<void> {
  const project = await q1<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  if (!project || project.cover_kind !== "auto") return;

  const posters = await q<{ poster_key: string }>(
    `SELECT m.poster_key FROM project_moments pm JOIN moments m ON m.id = pm.moment_id
     WHERE pm.project_id = $1 AND m.status = 'ready' AND m.poster_key IS NOT NULL
     ORDER BY m.recorded_at, m.id`,
    [projectId],
  );
  const store = await storage();

  if (posters.length === 0) {
    if (project.cover_key) {
      await store.delete(project.cover_key).catch(() => {});
      await exec(`UPDATE projects SET cover_key = NULL, cover_size = 0 WHERE id = $1`, [projectId]);
    }
    return;
  }

  // Начало, середина и конец истории: обложка меняется вместе с проектом.
  const picks =
    posters.length <= 3
      ? posters
      : [posters[0], posters[Math.floor(posters.length / 2)], posters[posters.length - 1]];

  const dir = await makeWorkDir("cover");
  try {
    const files: string[] = [];
    for (let i = 0; i < picks.length; i++) {
      const file = path.join(dir, `frame_${i}.jpg`);
      try {
        await store.downloadToFile(picks[i].poster_key, file);
        files.push(file);
      } catch {
        /* кадр мог быть удалён — пропускаем */
      }
    }
    if (files.length === 0) return;

    const out = path.join(dir, "cover.jpg");
    await renderCover(files, out);
    const version = project.cover_version + 1;
    const key = keys.projectCover(project.user_id, project.id, version);
    const size = await store.putFile(key, out, "image/jpeg");
    const saved = await exec(
      `UPDATE projects SET cover_key = $2, cover_size = $3, cover_version = $4, updated_at = now()
       WHERE id = $1 AND cover_version = $5`,
      [projectId, key, size, version, project.cover_version],
    );
    if (saved === 0) {
      await store.delete(key).catch(() => {});
      return;
    }
    if (project.cover_key && project.cover_key !== key) await store.delete(project.cover_key).catch(() => {});
  } finally {
    await removeWorkDir(dir);
  }
}
