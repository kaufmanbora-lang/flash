"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Clapperboard, Flame, Heart, Images, Search, SearchX, Video, X } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import useSWR from "swr";
import { errorText, fetcher } from "@/client/api";
import { useDrafts, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { Page, Reveal, TitleHeader } from "@/components/app/Page";
import { CreateFilmSheet } from "@/components/films/CreateFilmSheet";
import { OnThisDay } from "@/components/home/ActivityParts";
import { DraftTile, MomentThumb } from "@/components/moments/MomentThumb";
import { MomentViewer } from "@/components/moments/MomentViewer";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { EmptyState, LoadError, SectionTitle, Skeleton } from "@/components/ui/Feedback";
import { Sheet } from "@/components/ui/Sheet";
import {
  addDays,
  addMonths,
  eachDay,
  endOfMonth,
  endOfWeek,
  parseYmd,
  startOfMonth,
  startOfWeek,
  ymdOf,
  type Ymd,
} from "@/lib/dates";
import { capitalize, fmtDayMonth, fmtFullDate, fmtMonthName, fmtMonthYear, fmtWeekday, fmtWeekdayShort } from "@/lib/format";
import type { DaySummary, MomentDto, StatsDto } from "@/lib/types";

type Tab = "calendar" | "favorites" | "stats";

function MonthGrid({
  month,
  today,
  selected,
  days,
  onSelect,
}: {
  month: Ymd;
  today: Ymd;
  selected: Ymd;
  days: Map<Ymd, DaySummary>;
  onSelect: (day: Ymd) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const from = startOfWeek(startOfMonth(month));
  const to = endOfWeek(endOfMonth(month));
  const cells = eachDay(from, to);
  const monthNo = parseYmd(month).m;
  const weekdays = eachDay(from, addDays(from, 6)).map((d) => fmtWeekdayShort(d, locale));

  return (
    <div>
      <div className="mb-2 grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-strong" aria-hidden="true">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((date) => {
          const info = days.get(date);
          const inMonth = parseYmd(date).m === monthNo;
          const isToday = date === today;
          const isSelected = date === selected;
          const count = info?.count ?? 0;
          return (
            <button
              key={date}
              type="button"
              aria-label={t.archive.dayAria(fmtDayMonth(date, locale), count)}
              aria-pressed={isSelected}
              aria-current={isToday ? "date" : undefined}
              onClick={() => onSelect(date)}
              className={clsx(
                "press relative grid aspect-square min-h-[44px] place-items-center overflow-hidden rounded-[15px] text-[15px] font-semibold",
                !inMonth && "opacity-35",
                count === 0 && (isToday ? "bg-lime-soft text-leaf-deep" : "bg-white/50 text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.05)]"),
                isSelected && "shadow-[0_0_0_2.5px_var(--color-leaf-deep)]",
              )}
            >
              {count > 0 && info?.posterUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={info.posterUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
              )}
              {count > 0 && <span aria-hidden="true" className={clsx("absolute inset-0", info?.posterUrl ? "bg-black/35" : "bg-lime")} />}
              <span className={clsx("tabular relative", count > 0 && info?.posterUrl && "text-white [text-shadow:0_1px_4px_rgb(0_0_0/0.5)]")}>{parseYmd(date).d}</span>
              {count > 0 && (
                <span aria-hidden="true" className="absolute bottom-[5px] flex gap-[3px]">
                  {Array.from({ length: Math.min(3, count) }, (_, i) => (
                    <span key={i} className={clsx("size-[4px] rounded-full", info?.posterUrl ? "bg-white" : "bg-leaf-deep")} />
                  ))}
                </span>
              )}
              {isToday && count === 0 && <span aria-hidden="true" className="absolute bottom-[6px] size-1 rounded-full bg-leaf-deep" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MonthPicker({ open, onClose, month, onPick }: { open: boolean; onClose: () => void; month: Ymd; onPick: (m: Ymd) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [year, setYear] = useState(parseYmd(month).y);
  const current = parseYmd(month);
  return (
    <Sheet open={open} onClose={onClose} title={t.archive.pickMonthTitle}>
      <div className="mb-4 flex items-center justify-between">
        <IconButton label={t.archive.prevYear} onClick={() => setYear((y) => y - 1)}>
          <ChevronLeft aria-hidden="true" size={22} />
        </IconButton>
        <span className="tabular text-[22px] font-bold tracking-[-0.02em]" aria-live="polite">
          {year}
        </span>
        <IconButton label={t.archive.nextYear} onClick={() => setYear((y) => y + 1)}>
          <ChevronRight aria-hidden="true" size={22} />
        </IconButton>
      </div>
      <div className="grid grid-cols-3 gap-2.5 pb-2">
        {Array.from({ length: 12 }, (_, i) => {
          const active = current.y === year && current.m === i + 1;
          return (
            <button
              key={i}
              type="button"
              aria-pressed={active}
              onClick={() => {
                onPick(ymdOf(year, i + 1, 1));
                onClose();
              }}
              className={clsx("press min-h-[52px] rounded-[18px] text-[15px] font-semibold", active ? "btn-lime" : "glass")}
            >
              {capitalize(fmtMonthName(ymdOf(year, i + 1, 1), locale))}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** Столбчатая диаграмма; значения подписаны, для экранных дикторов — текстом. */
function Bars({ data, label }: { data: { key: string; label: string; value: number; hint: string }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ol className="flex h-[150px] items-end gap-1.5" aria-label={label}>
      {data.map((d, i) => (
        <li key={d.key} aria-label={d.hint} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
          <span aria-hidden="true" className="tabular text-[11px] font-semibold text-muted-strong">
            {d.value > 0 ? d.value : ""}
          </span>
          <motion.span
            aria-hidden="true"
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.6, delay: i * 0.03, ease: [0.22, 1, 0.36, 1] }}
            style={{ height: `${Math.max(d.value > 0 ? 6 : 2, (d.value / max) * 100)}%` }}
            className={clsx("w-full origin-bottom rounded-[8px]", d.value > 0 ? "bg-gradient-to-t from-leaf to-lime" : "bg-ink/8")}
          />
          <span aria-hidden="true" className="w-full truncate text-center text-[10.5px] font-semibold uppercase text-muted-strong">
            {d.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StatsView({ today, onOpen }: { today: Ymd; onOpen: (m: MomentDto) => void }) {
  const t = useT();
  const a = t.archive.stats;
  const { locale } = useLocale();
  const { data, error, mutate } = useSWR<{ stats: StatsDto; onThisDay: { year: number; date: Ymd; moments: MomentDto[] }[] }>(
    `/api/stats?today=${today}`,
    fetcher,
  );
  if (!data && error) return <LoadError message={errorText(t, error)} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton className="h-[420px] rounded-[28px]" />;
  const s = data.stats;
  if (s.totals.moments === 0) {
    return <EmptyState icon={<Video aria-hidden="true" size={26} strokeWidth={1.8} />} title={a.empty} />;
  }

  const months: { key: string; label: string; value: number; hint: string }[] = [];
  for (let i = 11; i >= 0; i--) {
    const first = addMonths(startOfMonth(today), -i);
    const key = first.slice(0, 7);
    const row = s.byMonth.find((m) => m.month === key);
    const name = fmtMonthName(first, locale);
    // Двенадцать столбцов на телефоне узкие: подпись — первая буква месяца, полное название — для диктора.
    months.push({ key, label: name.slice(0, 1), value: row?.count ?? 0, hint: `${capitalize(name)}: ${t.fmt.moments(row?.count ?? 0)}` });
  }
  const weekStart = startOfWeek(today);
  const weekdays = s.byWeekday.map((value, i) => {
    const day = addDays(weekStart, i);
    return { key: String(i), label: fmtWeekdayShort(day, locale), value, hint: `${capitalize(fmtWeekday(day, locale))}: ${t.fmt.moments(value)}` };
  });
  const tiles = [
    { label: a.moments, value: String(s.totals.moments) },
    { label: a.time, value: t.fmt.duration(s.totals.durationMs) },
    { label: a.days, value: String(s.totals.days) },
    { label: a.films, value: String(s.totals.films) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="glass px-4 py-4">
            {/* «5 мин 22 сек»: цифры крупно, единицы мелко — значение помещается в плитку одной строкой. */}
            <p className="tabular flex flex-wrap items-baseline gap-x-1 leading-none tracking-[-0.03em]">
              {tile.value.split(" ").map((part, i) =>
                /^\d/.test(part) ? (
                  <span key={i} className="text-[28px] font-bold">
                    {part}
                  </span>
                ) : (
                  <span key={i} className="text-[14px] font-semibold tracking-normal text-muted-strong">
                    {part}
                  </span>
                ),
              )}
            </p>
            <p className="t-caption mt-1.5">{tile.label}</p>
          </div>
        ))}
      </div>

      <div className="glass flex items-center gap-4 p-5">
        <span className="grid size-[54px] shrink-0 place-items-center rounded-[18px] bg-gradient-to-br from-lime-soft to-lime text-leaf-deep">
          <Flame aria-hidden="true" size={25} strokeWidth={1.9} />
        </span>
        <dl className="grid flex-1 grid-cols-2 gap-3">
          <div>
            <dd className="tabular text-[24px] font-bold leading-none tracking-[-0.03em]">{t.fmt.days(s.streak.current)}</dd>
            <dt className="t-caption mt-1">{a.streakNow}</dt>
          </div>
          <div>
            <dd className="tabular text-[24px] font-bold leading-none tracking-[-0.03em]">{t.fmt.days(s.streak.best)}</dd>
            <dt className="t-caption mt-1">{a.streakBest}</dt>
          </div>
        </dl>
      </div>

      <div className="glass p-5">
        <h2 className="t-section mb-4">{a.byMonth}</h2>
        <Bars data={months} label={a.byMonth} />
      </div>

      <div className="glass p-5">
        <h2 className="t-section mb-4">{a.byWeekday}</h2>
        <Bars data={weekdays} label={a.byWeekday} />
      </div>

      {data.onThisDay.length > 0 && <OnThisDay groups={data.onThisDay} today={today} onOpen={onOpen} />}

      {s.firstDate && <p className="text-center text-[13px] text-muted-strong">{a.since(fmtFullDate(s.firstDate, locale))}</p>}
    </div>
  );
}

export default function CalendarPage() {
  const t = useT();
  const a = t.archive;
  const { locale } = useLocale();
  const today = useToday();
  const drafts = useDrafts();

  const [tab, setTab] = useState<Tab>("calendar");
  const [month, setMonth] = useState<Ymd>(() => startOfMonth(today));
  const [selected, setSelected] = useState<Ymd>(today);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<MomentDto | null>(null);
  const [picker, setPicker] = useState(false);
  const [filmSheet, setFilmSheet] = useState(false);
  const deferredQuery = useDeferredValue(query.trim());

  const gridFrom = startOfWeek(startOfMonth(month));
  const gridTo = endOfWeek(endOfMonth(month));
  const { data: monthData, error: monthError, mutate: reloadMonth } = useSWR<{ days: DaySummary[] }>(
    tab === "calendar" && !searching ? `/api/calendar?from=${gridFrom}&to=${gridTo}` : null,
    fetcher,
  );
  const { data: dayData } = useSWR<{ moments: MomentDto[] }>(
    tab === "calendar" && !searching ? `/api/moments?date=${selected}&order=asc` : null,
    fetcher,
    { refreshInterval: (d) => (d?.moments.some((m) => m.status === "processing") ? 3000 : 0) },
  );
  const { data: found, isLoading: finding } = useSWR<{ moments: MomentDto[] }>(
    searching && deferredQuery.length >= 2 ? `/api/moments?q=${encodeURIComponent(deferredQuery)}&limit=90` : null,
    fetcher,
  );
  const { data: favorites } = useSWR<{ moments: MomentDto[] }>(tab === "favorites" && !searching ? "/api/moments?favorite=1&limit=200" : null, fetcher);

  const dayMap = useMemo(() => new Map((monthData?.days ?? []).map((d) => [d.date, d])), [monthData]);
  const dayMoments = dayData?.moments ?? [];
  const dayDrafts = drafts.filter((d) => d.localDate === selected);
  const dayReady = dayMoments.filter((m) => m.status === "ready");
  const dayDuration = dayReady.reduce((s, m) => s + m.durationMs, 0);

  const pickDay = (date: Ymd) => {
    setSelected(date);
    if (startOfMonth(date) !== month) setMonth(startOfMonth(date));
  };

  const grouped = useMemo(() => {
    const groups = new Map<Ymd, MomentDto[]>();
    for (const m of found?.moments ?? []) groups.set(m.date, [...(groups.get(m.date) ?? []), m]);
    return [...groups.entries()];
  }, [found]);

  return (
    <Page>
      <TitleHeader
        title={a.title}
        actions={
          <IconButton
            label={searching ? a.closeSearch : a.search}
            aria-expanded={searching}
            onClick={() => {
              setSearching((v) => !v);
              setQuery("");
            }}
          >
            {searching ? <X aria-hidden="true" size={21} /> : <Search aria-hidden="true" size={20} />}
          </IconButton>
        }
      />

      <AnimatePresence initial={false}>
        {searching && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="pb-4">
              <label htmlFor="archive-search" className="sr-only">
                {a.search}
              </label>
              <div className="glass flex min-h-[54px] items-center gap-2.5 rounded-full px-4">
                <Search aria-hidden="true" size={19} className="shrink-0 text-muted-strong" />
                <input
                  id="archive-search"
                  type="search"
                  autoFocus
                  enterKeyHint="search"
                  autoComplete="off"
                  placeholder={a.searchPlaceholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent py-3 outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
                />
              </div>
              <p className="t-caption mt-2 px-2">{a.searchHint}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {searching ? (
        <div className="flex flex-col gap-5" aria-live="polite">
          {deferredQuery.length >= 2 && finding && !found && <Skeleton className="h-[180px] rounded-[28px]" />}
          {found && found.moments.length === 0 && (
            <EmptyState icon={<SearchX aria-hidden="true" size={26} strokeWidth={1.8} />} title={a.noResults} text={a.noResultsHint} />
          )}
          {found && found.moments.length > 0 && <p className="px-1 text-[14px] font-semibold text-leaf-deep">{a.results(found.moments.length)}</p>}
          {grouped.map(([date, list]) => (
            <section key={date}>
              <SectionTitle>{fmtFullDate(date, locale)}</SectionTitle>
              <div className="grid grid-cols-3 gap-3">
                {list.map((m) => (
                  <div key={m.id}>
                    <MomentThumb moment={m} caption={m.time} onClick={() => setViewing(m)} className="w-full" />
                    {m.note && <p className="t-caption mt-1.5 line-clamp-2 px-0.5">{m.note}</p>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <Segmented<Tab>
            label={a.title}
            value={tab}
            onChange={setTab}
            options={[
              { value: "calendar", label: a.tabs.calendar },
              { value: "favorites", label: a.tabs.favorites },
              { value: "stats", label: a.tabs.stats },
            ]}
          />

          <div className="mt-5">
            {tab === "calendar" && (
              <div className="flex flex-col gap-5">
                <Reveal className="glass p-4">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <IconButton label={a.prevMonth} tone="plain" onClick={() => setMonth(addMonths(month, -1))}>
                      <ChevronLeft aria-hidden="true" size={22} />
                    </IconButton>
                    <button
                      type="button"
                      onClick={() => setPicker(true)}
                      aria-label={`${a.pickMonth}: ${fmtMonthYear(month, locale)}`}
                      className="press min-h-[44px] rounded-full px-4 text-[18px] font-semibold tracking-[-0.015em]"
                    >
                      <span aria-live="polite">{fmtMonthYear(month, locale)}</span>
                    </button>
                    <IconButton label={a.nextMonth} tone="plain" onClick={() => setMonth(addMonths(month, 1))}>
                      <ChevronRight aria-hidden="true" size={22} />
                    </IconButton>
                  </div>
                  {monthError && !monthData ? (
                    <LoadError message={errorText(t, monthError)} onRetry={() => void reloadMonth()} />
                  ) : (
                    <MonthGrid month={month} today={today} selected={selected} days={dayMap} onSelect={pickDay} />
                  )}
                  {startOfMonth(today) !== month && (
                    <div className="mt-3 flex justify-center">
                      <Button variant="ghost" size="sm" onClick={() => pickDay(today)}>
                        {a.toToday}
                      </Button>
                    </div>
                  )}
                </Reveal>

                <Reveal delay={1}>
                  <div className="mb-3 px-1">
                    <h2 className="t-section">{selected === today ? t.common.today : selected === addDays(today, -1) ? t.common.yesterday : fmtDayMonth(selected, locale)}</h2>
                    <p className="t-caption mt-0.5">
                      {capitalize(fmtWeekday(selected, locale))}
                      {dayReady.length > 0 ? ` · ${a.daySummary(dayReady.length, dayDuration)}` : ""}
                    </p>
                  </div>

                  {dayMoments.length + dayDrafts.length > 0 ? (
                    <div className="grid grid-cols-3 gap-3">
                      {dayMoments.map((m) => (
                        <MomentThumb key={m.id} moment={m} caption={m.time} onClick={() => setViewing(m)} className="w-full" />
                      ))}
                      {dayDrafts.map((d) => (
                        <DraftTile key={d.clientId} draft={d} className="w-full" />
                      ))}
                    </div>
                  ) : !dayData ? (
                    <div className="grid grid-cols-3 gap-3">
                      <Skeleton className="aspect-[4/5] rounded-[22px]" />
                      <Skeleton className="aspect-[4/5] rounded-[22px]" />
                    </div>
                  ) : (
                    <div className="glass px-5 py-6 text-center">
                      <p className="text-[15px] text-muted-strong">
                        {selected > today ? a.dayFuture : selected === today ? a.dayEmptyToday : a.dayEmpty}
                      </p>
                      {selected <= today && (
                        <Link
                          href="/record"
                          className="press mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-[14.5px] font-semibold text-leaf-deep"
                        >
                          {selected === today ? <Video aria-hidden="true" size={17} /> : <Images aria-hidden="true" size={17} />}
                          {selected === today ? a.recordNow : a.uploadForDay}
                        </Link>
                      )}
                    </div>
                  )}

                  {dayReady.length > 0 && (
                    <Button variant="glass" block className="mt-4" icon={<Clapperboard aria-hidden="true" size={18} />} onClick={() => setFilmSheet(true)}>
                      {a.makeDayFilm}
                    </Button>
                  )}
                </Reveal>
              </div>
            )}

            {tab === "favorites" &&
              (!favorites ? (
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton className="aspect-[4/5] rounded-[22px]" />
                  <Skeleton className="aspect-[4/5] rounded-[22px]" />
                  <Skeleton className="aspect-[4/5] rounded-[22px]" />
                </div>
              ) : favorites.moments.length === 0 ? (
                <EmptyState icon={<Heart aria-hidden="true" size={26} strokeWidth={1.8} />} title={a.favoritesEmpty} text={a.favoritesEmptyHint} />
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {favorites.moments.map((m) => (
                    <MomentThumb key={m.id} moment={m} caption={fmtDayMonth(m.date, locale)} onClick={() => setViewing(m)} className="w-full" />
                  ))}
                </div>
              ))}

            {tab === "stats" && <StatsView today={today} onOpen={setViewing} />}
          </div>
        </>
      )}

      <MonthPicker open={picker} onClose={() => setPicker(false)} month={month} onPick={setMonth} />
      <CreateFilmSheet open={filmSheet} onClose={() => setFilmSheet(false)} initialKind="day" initialDate={selected} />
      <MomentViewer moment={viewing} onClose={() => setViewing(null)} />
    </Page>
  );
}
