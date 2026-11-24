// Серверный планировщик. Работает в процессе воркера и раз в полминуты:
//   • планирует и рассылает напоминания (по местному времени каждого пользователя);
//   • в выбранное вечернее время собирает фильм дня;
//   • завершает проекты, у которых вышел срок, и запускает финальный фильм.

import { getDict } from "@/i18n";
import { MAX_MOMENTS_PER_DAY } from "@/lib/constants";
import { diffDays, hmToMinutes, startOfYear, zonedParts, zonedToUtc, type Ymd } from "@/lib/dates";
import { exec, q, q1 } from "@/lib/db";
import { createFilm } from "@/lib/film-service";
import { cleanupAbandonedUploads, countForDay } from "@/lib/moment-service";
import { completeProject } from "@/lib/project-service";
import { projectProgress } from "@/lib/projects";
import { cleanupPush, sendPush, type PushPayload } from "@/lib/push";
import { cleanupJobs } from "@/lib/queue";
import { expectedSlots, inQuietHours, planDay } from "@/lib/reminders";
import { resolveSettings, type UserSettings } from "@/lib/settings";
import { keys, storage } from "@/lib/storage";
import type { MomentRow, ProjectRow, UserRow } from "@/lib/types";
import { cleanupSessions } from "@/lib/user-service";

const log = (msg: string) => console.log(`[scheduler] ${msg}`);

// ── Напоминания ──────────────────────────────────────────────

async function ensurePlan(user: UserRow, settings: UserSettings, today: Ymd, now: Date): Promise<void> {
  const n = settings.notifications;
  const have = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM push_plan WHERE user_id = $1 AND local_date = $2`,
    [user.id, today],
  );
  if ((have?.n ?? 0) >= expectedSlots(n)) return;

  for (const slot of planDay(n, `${user.id}:${today}`)) {
    const fireAt = slot.time ? zonedToUtc(today, slot.time, user.timezone) : now;
    // Время уже прошло (план составлен среди дня) — слот считается пропущенным, а не шлётся с опозданием.
    const status = !slot.time || fireAt.getTime() < now.getTime() - 60_000 ? "skipped" : "pending";
    await exec(
      `INSERT INTO push_plan (user_id, local_date, slot, fire_at, status, handled_at)
       VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'pending' THEN NULL ELSE now() END)
       ON CONFLICT (user_id, local_date, slot) DO NOTHING`,
      [user.id, today, slot.slot, fireAt, status],
    );
  }
}

interface Candidate {
  priority: number;
  dedupeKey: string;
  title: string;
  body: string;
  /** Такое уведомление приходит один раз за проект. */
  once: boolean;
  endsAt: Ymd | null;
}

/**
 * Текст одного напоминания. Сколько бы проектов ни было активно, на один слот приходит одно
 * уведомление: выбирается самое важное событие (последний день → три дня → половина → обычный день).
 */
export async function composeReminder(
  user: UserRow,
  today: Ymd,
  slot: number,
): Promise<{ payload: PushPayload; dedupeKey: string } | null> {
  const count = await countForDay(user.id, today);
  if (count >= MAX_MOMENTS_PER_DAY) return null; // на сегодня всё записано

  const t = getDict(user.locale).push;
  const projects = await q<ProjectRow>(
    `SELECT * FROM projects WHERE user_id = $1 AND status = 'active' AND start_date <= $2
     ORDER BY end_date NULLS LAST, created_at`,
    [user.id, today],
  );

  const candidates: Candidate[] = [];
  for (const p of projects) {
    const progress = projectProgress(p, today);
    if (!progress.started || progress.overdue) continue;
    const quoted = `«${p.title}»`;
    if (progress.isLastDay) {
      candidates.push({ priority: 4, dedupeKey: `proj:${p.id}:lastday`, title: quoted, body: t.projectLastDay, once: true, endsAt: p.end_date });
    } else if (progress.daysLeft === 3) {
      candidates.push({ priority: 3, dedupeKey: `proj:${p.id}:left3`, title: quoted, body: t.projectThreeLeft, once: true, endsAt: p.end_date });
    } else if (progress.totalDays !== null && progress.totalDays >= 4 && progress.dayIndex === Math.ceil(progress.totalDays / 2)) {
      candidates.push({ priority: 2, dedupeKey: `proj:${p.id}:half`, title: quoted, body: t.projectHalf, once: true, endsAt: p.end_date });
    }
    if (count === 0) {
      candidates.push({
        priority: 1,
        dedupeKey: `remind:${today}:${slot}`,
        title: quoted,
        body:
          progress.totalDays !== null
            ? t.projectDay(progress.dayIndex, progress.totalDays)
            : t.projectDayOpen(progress.dayIndex),
        once: false,
        endsAt: p.end_date,
      });
    }
  }
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (a.endsAt ?? "9999-12-31") < (b.endsAt ?? "9999-12-31") ? -1 : 1;
  });

  for (const c of candidates) {
    if (c.once) {
      const sent = await q1(`SELECT 1 FROM push_log WHERE user_id = $1 AND dedupe_key = $2`, [user.id, c.dedupeKey]);
      if (sent) continue;
    }
    return {
      payload: { title: c.title, body: c.body, url: "/record", kind: "reminder", tag: "flash-reminder" },
      dedupeKey: c.dedupeKey,
    };
  }

  const dedupeKey = `remind:${today}:${slot}`;
  if (count > 0) {
    return {
      payload: { title: t.anotherTitle, body: t.another(count, MAX_MOMENTS_PER_DAY), url: "/record", kind: "reminder", tag: "flash-reminder" },
      dedupeKey,
    };
  }
  const dayOfYear = diffDays(today, startOfYear(today));
  const phrase = t.generic[(dayOfYear * 3 + slot) % t.generic.length];
  return {
    payload: { title: t.genericTitle, body: phrase, url: "/record", kind: "reminder", tag: "flash-reminder" },
    dedupeKey,
  };
}

async function remindersTick(now: Date): Promise<void> {
  const users = await q<UserRow>(
    `SELECT u.* FROM users u WHERE EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)`,
  );
  const byId = new Map<string, { user: UserRow; settings: UserSettings }>();
  for (const user of users) {
    const settings = resolveSettings(user.settings);
    byId.set(user.id, { user, settings });
    if (!settings.notifications.enabled) continue;
    try {
      await ensurePlan(user, settings, zonedParts(now, user.timezone).ymd, now);
    } catch (err) {
      console.error("[scheduler] план напоминаний:", err);
    }
  }

  // Забираем наступившие слоты атомарно: два воркера не отправят одно напоминание дважды.
  const due = await q<{ id: number; user_id: string; local_date: Ymd; slot: number; fire_at: Date }>(
    `UPDATE push_plan SET status = 'sent', handled_at = now()
     WHERE id IN (
       SELECT id FROM push_plan WHERE status = 'pending' AND fire_at <= now()
       ORDER BY fire_at FOR UPDATE SKIP LOCKED LIMIT 100
     )
     RETURNING id, user_id, local_date, slot, fire_at`,
  );
  for (const row of due) {
    const skip = () => exec(`UPDATE push_plan SET status = 'skipped' WHERE id = $1`, [row.id]);
    const entry = byId.get(row.user_id);
    try {
      if (!entry || !entry.settings.notifications.enabled) {
        await skip();
        continue;
      }
      // Опоздавшее больше чем на полчаса напоминание уже неуместно.
      if (now.getTime() - row.fire_at.getTime() > 30 * 60_000) {
        await skip();
        continue;
      }
      const local = zonedParts(now, entry.user.timezone);
      if (inQuietHours(local.minutes, entry.settings.notifications)) {
        await skip();
        continue;
      }
      const reminder = await composeReminder(entry.user, local.ymd, row.slot);
      if (!reminder) {
        await skip();
        continue;
      }
      const delivered = await sendPush(row.user_id, reminder.payload, { dedupeKey: reminder.dedupeKey, ttlSec: 3600 });
      if (delivered < 0) await skip();
    } catch (err) {
      console.error("[scheduler] напоминание:", err);
    }
  }
}

// ── Фильм дня ────────────────────────────────────────────────

async function dailyFilmsTick(now: Date): Promise<void> {
  const users = await q<UserRow>(
    `SELECT * FROM users u WHERE EXISTS (
       SELECT 1 FROM moments m WHERE m.user_id = u.id AND m.created_at > now() - interval '3 days')`,
  );
  for (const user of users) {
    try {
      const settings = resolveSettings(user.settings);
      if (!settings.dailyFilm.enabled) continue;
      const local = zonedParts(now, user.timezone);
      if (local.minutes < hmToMinutes(settings.dailyFilm.time)) continue;
      const today = local.ymd;

      const counts = await q1<{ ready: number; busy: number }>(
        `SELECT count(*) FILTER (WHERE status = 'ready')::int AS ready,
                count(*) FILTER (WHERE status = 'processing'
                                 OR (status = 'uploading' AND updated_at > now() - interval '10 minutes'))::int AS busy
         FROM moments WHERE user_id = $1 AND local_date = $2`,
        [user.id, today],
      );
      // Ждём, пока догрузятся и обработаются моменты, записанные прямо перед вечерним временем.
      if (!counts || counts.ready === 0 || counts.busy > 0) continue;

      // Отметка «на сегодня фильм дня уже создавался»: удалённый вручную фильм не воскреснет.
      const marker = await q1(
        `INSERT INTO push_log (user_id, dedupe_key, kind, title, body) VALUES ($1, $2, 'marker', '', '')
         ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
        [user.id, `dailyfilm:${today}`],
      );
      if (!marker) continue;

      const existing = await q1(
        `SELECT 1 FROM films WHERE user_id = $1 AND project_id IS NULL AND kind = 'day' AND date_from = $2`,
        [user.id, today],
      );
      if (existing) continue; // пользователь уже собрал фильм за сегодня сам

      await createFilm(
        user,
        settings,
        { kind: "day", dateFrom: today, dateTo: today, variant: settings.dailyFilm.variant },
        { auto: true },
      );
      log(`фильм дня ${today} поставлен в очередь (${user.email})`);
    } catch (err) {
      console.error("[scheduler] фильм дня:", err);
    }
  }
}

// ── Проекты ──────────────────────────────────────────────────

async function projectsTick(now: Date): Promise<void> {
  const rows = await q<ProjectRow>(
    `SELECT * FROM projects
     WHERE status = 'active' AND end_date IS NOT NULL AND end_date < (now() + interval '15 hours')::date`,
  );
  for (const project of rows) {
    try {
      const user = await q1<UserRow>(`SELECT * FROM users WHERE id = $1`, [project.user_id]);
      if (!user) continue;
      const today = zonedParts(now, user.timezone).ymd;
      if (project.end_date! >= today) continue; // последний день ещё идёт

      const busy = await q1<{ n: number }>(
        `SELECT count(*)::int AS n FROM project_moments pm JOIN moments m ON m.id = pm.moment_id
         WHERE pm.project_id = $1 AND (m.status = 'processing'
               OR (m.status = 'uploading' AND m.updated_at > now() - interval '10 minutes'))`,
        [project.id],
      );
      if ((busy?.n ?? 0) > 0) continue;

      const settings = resolveSettings(user.settings);
      const { film } = await completeProject(user, settings, project, today, { early: false });
      log(`проект «${project.title}» завершён${film ? ", финальный фильм в очереди" : ""}`);
      if (!film && settings.notifications.enabled) {
        const t = getDict(user.locale).push;
        await sendPush(
          user.id,
          { title: t.projectDoneTitle(project.title), body: t.projectDoneNoMoments, url: `/projects/${project.id}`, kind: "project_done" },
          { dedupeKey: `proj:${project.id}:done`, ttlSec: 24 * 3600 },
        );
      }
    } catch (err) {
      console.error("[scheduler] завершение проекта:", err);
    }
  }
}

// ── Обслуживание ─────────────────────────────────────────────

async function cleanupFailedMoments(): Promise<void> {
  const rows = await q<MomentRow>(
    `SELECT * FROM moments WHERE status = 'failed' AND updated_at < now() - interval '7 days' LIMIT 200`,
  );
  const store = await storage();
  for (const row of rows) {
    await store.deletePrefix(keys.momentPrefix(row.user_id, row.id)).catch(() => {});
    await exec(`DELETE FROM moments WHERE id = $1 AND status = 'failed'`, [row.id]);
  }
}

export async function schedulerTick(now: Date = new Date()): Promise<void> {
  const results = await Promise.allSettled([remindersTick(now), dailyFilmsTick(now), projectsTick(now)]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[scheduler] ошибка такта:", r.reason);
  }
}

export async function maintenanceTick(): Promise<void> {
  const tasks: [string, () => Promise<unknown>][] = [
    ["сессии", cleanupSessions],
    ["брошенные загрузки", () => cleanupAbandonedUploads(24)],
    ["задачи", cleanupJobs],
    ["push", cleanupPush],
    ["неудачные моменты", cleanupFailedMoments],
  ];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (err) {
      console.error(`[scheduler] обслуживание (${name}):`, err);
    }
  }
}
