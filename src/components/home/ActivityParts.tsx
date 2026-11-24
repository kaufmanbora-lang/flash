"use client";

import clsx from "clsx";
import { Flame, History } from "lucide-react";
import { useLocale, useT } from "@/client/i18n";
import { MomentThumb } from "@/components/moments/MomentThumb";
import { addDays, eachDay, parseYmd, startOfWeek, type Ymd } from "@/lib/dates";
import { fmtDayMonth, fmtWeekdayShort } from "@/lib/format";
import type { DaySummary, MomentDto, StreakInfo } from "@/lib/types";

/** Серия дней подряд и активность за последние пять недель. */
export function ActivityCard({ streak, activity, today }: { streak: StreakInfo; activity: DaySummary[]; today: Ymd }) {
  const t = useT();
  const h = t.home;
  const { locale } = useLocale();
  const byDate = new Map(activity.map((d) => [d.date, d]));
  const from = addDays(startOfWeek(today), -28);
  const days = eachDay(from, addDays(startOfWeek(today), 6));
  const weekdays = eachDay(startOfWeek(today), addDays(startOfWeek(today), 6)).map((d) => fmtWeekdayShort(d, locale));

  return (
    <div className="glass p-5">
      <div className="flex items-center gap-4">
        <span
          className={clsx(
            "grid size-[58px] shrink-0 place-items-center rounded-[20px] shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]",
            streak.current > 0 ? "bg-gradient-to-br from-lime-soft to-lime text-leaf-deep" : "bg-ink/6 text-muted",
          )}
        >
          <Flame aria-hidden="true" size={27} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 leading-none">
            <span className="tabular text-[34px] font-bold tracking-[-0.04em]">{streak.current}</span>
            <span className="text-[16px] font-semibold">{h.streakUnit(streak.current)}</span>
          </p>
          <p className="t-caption mt-1.5">
            {streak.current === 0 ? h.streakStart : streak.todayDone ? h.streakBest(streak.best) : h.streakKeep}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-strong" aria-hidden="true">
          {weekdays.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
        <ol className="grid grid-cols-7 gap-1.5" aria-label={h.activity}>
          {days.map((date) => {
            const count = byDate.get(date)?.count ?? 0;
            const future = date > today;
            const isToday = date === today;
            return (
              <li
                key={date}
                aria-label={`${fmtDayMonth(date, locale)}: ${count > 0 ? t.fmt.moments(count) : h.noMoments}`}
                aria-current={isToday ? "date" : undefined}
                className={clsx(
                  "tabular grid h-9 place-items-center rounded-[12px] text-[12.5px] font-semibold",
                  future && "text-muted/60",
                  !future && count === 0 && "bg-ink/5 text-muted-strong",
                  count === 1 && "bg-lime-soft text-leaf-deep",
                  count === 2 && "bg-lime text-ink",
                  count >= 3 && "bg-leaf text-white",
                  isToday && "ring-2 ring-leaf-deep ring-offset-2 ring-offset-white/60",
                )}
              >
                {parseYmd(date).d}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/** «В этот день»: моменты, записанные в эту же дату в прошлые годы. */
export function OnThisDay({
  groups,
  today,
  onOpen,
}: {
  groups: { year: number; date: Ymd; moments: MomentDto[] }[];
  today: Ymd;
  onOpen: (moment: MomentDto) => void;
}) {
  const t = useT();
  const nowYear = parseYmd(today).y;
  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-[15px] bg-lime-soft text-leaf-deep">
          <History aria-hidden="true" size={21} strokeWidth={1.9} />
        </span>
        <div>
          <h2 className="t-section">{t.home.onThisDay}</h2>
          <p className="t-caption">{t.home.onThisDayHint}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.date}>
            <p className="mb-2 text-[14px] font-semibold text-leaf-deep">{t.home.yearsAgo(nowYear - group.year)}</p>
            <div className="no-scrollbar -mx-5 flex gap-2.5 overflow-x-auto px-5">
              {group.moments.map((moment) => (
                <MomentThumb key={moment.id} moment={moment} caption={moment.time} onClick={() => onOpen(moment)} className="w-[112px] shrink-0" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
