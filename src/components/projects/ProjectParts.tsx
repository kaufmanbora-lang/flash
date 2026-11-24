"use client";

import clsx from "clsx";
import { CalendarDays, Check, Clock3, Pause, Video } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale, useT } from "@/client/i18n";
import type { Dict } from "@/i18n";
import { Badge, ProgressBar } from "@/components/ui/Feedback";
import { COVER_GRADIENTS } from "@/lib/constants";
import { fmtDayMonth, fmtRange } from "@/lib/format";
import type { ProjectDay } from "@/lib/projects";
import type { ProjectDto } from "@/lib/types";

/** Обложка проекта: кадры из записанных моментов или мягкий градиент, пока кадров нет. */
export function ProjectCover({
  cover,
  className,
  children,
  shade = true,
}: {
  cover: ProjectDto["cover"];
  className?: string;
  children?: ReactNode;
  shade?: boolean;
}) {
  return (
    <div className={clsx("relative isolate overflow-hidden bg-lime-soft", className)} style={cover.url ? undefined : { background: COVER_GRADIENTS[cover.preset] }}>
      {cover.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover.url} alt="" decoding="async" draggable={false} className="absolute inset-0 -z-10 size-full object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(60% 80% at 85% 10%, rgb(255 255 255 / 0.55), transparent 60%), radial-gradient(50% 70% at 10% 100%, rgb(255 255 255 / 0.35), transparent 60%)",
          }}
        />
      )}
      {shade && (
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 -z-[5]",
            cover.url
              ? "bg-gradient-to-tr from-black/65 via-black/25 to-black/5"
              : "bg-gradient-to-tr from-leaf-deep/45 via-leaf-deep/10 to-transparent",
          )}
        />
      )}
      {children}
    </div>
  );
}

export function projectDates(project: Pick<ProjectDto, "startDate" | "endDate">, locale: string, t: Dict): string {
  if (!project.endDate) return t.project.openEnded(fmtDayMonth(project.startDate, locale));
  return fmtRange(project.startDate, project.endDate, locale, false);
}

/** Короткая фраза о состоянии проекта: «Твоя история продолжается», «Осталось 3 дня» и т. п. */
export function projectMood(project: ProjectDto, locale: string, t: Dict): string {
  const pr = project.progress;
  const p = t.project;
  if (project.status === "completed") return p.completed;
  if (project.status === "paused") return p.pausedHint;
  if (!pr.started) return p.startsOn(fmtDayMonth(project.startDate, locale));
  if (pr.isLastDay) return p.lastDay;
  if (pr.daysLeft !== null && pr.daysLeft <= 3) return p.left(pr.daysLeft);
  return p.continues;
}

export function projectDayLabel(project: ProjectDto, t: Dict): string {
  const pr = project.progress;
  if (!pr.started) return t.project.notStarted;
  return pr.totalDays !== null ? t.project.dayOf(pr.dayIndex, pr.totalDays) : t.project.dayOpen(pr.dayIndex);
}

/** Карточка прогресса: «День 18 из 30», процент и шкала. */
export function ProjectProgressCard({ project, className }: { project: ProjectDto; className?: string }) {
  const t = useT();
  const { locale } = useLocale();
  const pr = project.progress;
  return (
    <div className={clsx("glass px-5 py-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[19px] font-semibold tracking-[-0.02em]">{projectDayLabel(project, t)}</span>
        {project.status === "paused" ? (
          <Badge tone="muted" icon={<Pause aria-hidden="true" size={12} fill="currentColor" strokeWidth={0} />}>
            {t.project.paused}
          </Badge>
        ) : pr.percent !== null ? (
          <span className="tabular text-[19px] font-semibold text-leaf-deep">{pr.percent}%</span>
        ) : (
          <span className="text-[14px] font-semibold text-leaf-deep">{t.project.open}</span>
        )}
      </div>
      {pr.percent !== null && <ProgressBar value={pr.percent} label={t.project.progressAria} className="mt-3" />}
      <p className="mt-2.5 text-[14px] text-muted-strong">
        {(() => {
          const mood = projectMood(project, locale, t);
          // На паузе дату окончания не показываем: она сдвигается, пока проект стоит.
          const showEnd = pr.expectedEnd && project.status === "active" && pr.started && !pr.isLastDay;
          // Перед « · до 6 декабря» точка в конце фразы лишняя.
          return showEnd ? `${mood.replace(/\.$/, "")} · ${t.project.until(fmtDayMonth(pr.expectedEnd!, locale))}` : mood;
        })()}
      </p>
    </div>
  );
}

/** Календарь проекта: пронумерованные дни с отметками записи. Только отображение, без нажатий. */
export function DayGrid({ days, today }: { days: ProjectDay[]; today: string }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <ol className="grid grid-cols-7 gap-1.5 min-[400px]:grid-cols-10" aria-label={t.project.calendar}>
      {days.map((day) => {
        const isToday = day.date === today;
        const label = `${fmtDayMonth(day.date, locale)}: ${t.project.dayStates[day.state]}${day.count > 0 ? `, ${t.fmt.moments(day.count)}` : ""}`;
        return (
          <li
            key={day.date}
            aria-label={label}
            aria-current={isToday ? "date" : undefined}
            className={clsx(
              "tabular relative grid aspect-square place-items-center rounded-[11px] text-[13px] font-semibold leading-none",
              isToday && "bg-leaf-deep text-white shadow-[0_6px_14px_-6px_rgb(62_116_32/0.8)]",
              !isToday && day.state === "recorded" && "bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.8)]",
              !isToday && day.state === "missed" && "bg-ink/5 text-muted",
              !isToday && day.state === "future" && "bg-white/55 text-muted-strong shadow-[inset_0_0_0_1px_rgb(32_48_30/0.06)]",
              !isToday && day.state === "paused" && "bg-[repeating-linear-gradient(135deg,rgb(32_48_30/0.07)_0_3px,transparent_3px_6px)] text-muted",
              !isToday && day.state === "today" && "bg-white/55 text-ink",
            )}
          >
            <span aria-hidden="true" className={day.count > 0 ? "-translate-y-[3px]" : undefined}>
              {day.index ?? "·"}
            </span>
            {day.count > 0 && (
              <Check aria-hidden="true" size={9} strokeWidth={3.5} className={clsx("absolute bottom-[3px]", isToday ? "text-white" : "text-leaf-deep")} />
            )}
            {isToday && day.count === 0 && <span aria-hidden="true" className="absolute bottom-[4px] size-1 rounded-full bg-white" />}
          </li>
        );
      })}
    </ol>
  );
}

/** Три плитки: моменты, записанное время, оставшиеся дни. */
export function ProjectStats({ project }: { project: ProjectDto }) {
  const t = useT();
  const pr = project.progress;
  const minutes = Math.floor(project.durationMs / 60000);
  const tiles: { icon: ReactNode; value: string; unit?: string; label: string }[] = [
    { icon: <Video aria-hidden="true" size={18} />, value: String(project.momentsCount), label: t.fmt.momentsWordCap(project.momentsCount) },
    minutes >= 1
      ? { icon: <Clock3 aria-hidden="true" size={18} />, value: String(minutes), unit: t.fmt.minShort, label: t.project.recorded }
      : { icon: <Clock3 aria-hidden="true" size={18} />, value: String(Math.round(project.durationMs / 1000)), unit: t.fmt.secShort, label: t.project.recorded },
    pr.daysLeft !== null && project.status !== "completed"
      ? { icon: <CalendarDays aria-hidden="true" size={18} />, value: String(pr.daysLeft), unit: t.fmt.daysWord(pr.daysLeft), label: t.project.leftLabel }
      : { icon: <CalendarDays aria-hidden="true" size={18} />, value: String(project.daysRecorded), unit: t.fmt.daysWord(project.daysRecorded), label: t.project.daysWithMoments },
  ];
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {tiles.map((tile) => (
        <div key={tile.label} className="glass rounded-[22px] px-3.5 py-3.5">
          <span className="grid size-9 place-items-center rounded-[12px] bg-lime-soft text-leaf-deep">{tile.icon}</span>
          <p className="tabular mt-2.5 text-[26px] font-bold leading-none tracking-[-0.03em]">
            {tile.value}
            {tile.unit && <span className="ml-1 text-[15px] font-semibold tracking-normal">{tile.unit}</span>}
          </p>
          <p className="t-caption mt-1 truncate">{tile.label}</p>
        </div>
      ))}
    </div>
  );
}
