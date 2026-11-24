"use client";

import { ChevronDown, Clapperboard } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { api, errorText, fetcher } from "@/client/api";
import { useMe, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import {
  addDays,
  endOfMonth,
  endOfWeek,
  endOfYear,
  isValidYmd,
  parseYmd,
  startOfMonth,
  startOfWeek,
  startOfYear,
  ymdOf,
  type Ymd,
} from "@/lib/dates";
import { capitalize, fmtMonthName, fmtRange } from "@/lib/format";
import type { DaySummary, FilmDto, FilmOptions } from "@/lib/types";
import { renderHref } from "./FilmCard";
import { FilmOptionsFields } from "./FilmOptions";

type Kind = "day" | "week" | "month" | "year" | "custom";

const dateInput =
  "min-h-[52px] w-full rounded-[18px] bg-white/80 px-4 text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-leaf)]";

/** Шторка «Собрать фильм»: период, версия, оформление. */
export function CreateFilmSheet({
  open,
  onClose,
  initialKind = "day",
  initialDate,
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: Kind;
  initialDate?: Ymd;
}) {
  const t = useT();
  const f = t.films;
  const toast = useToast();
  const router = useRouter();
  const today = useToday();
  const { locale } = useLocale();
  const { data: me } = useMe();

  const [kind, setKind] = useState<Kind>(initialKind);
  const [anchor, setAnchor] = useState<Ymd>(initialDate ?? today);
  const [customFrom, setCustomFrom] = useState<Ymd>(addDays(today, -6));
  const [customTo, setCustomTo] = useState<Ymd>(today);
  const [variant, setVariant] = useState<"full" | "highlights">("full");
  const [options, setOptions] = useState<FilmOptions | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setAnchor(initialDate ?? today);
      setVariant("full");
      setLookOpen(false);
    }
  }, [open, initialKind, initialDate, today]);

  useEffect(() => {
    if (me && !options) setOptions(me.settings.film);
  }, [me, options]);

  const [from, to] = useMemo<[Ymd, Ymd]>(() => {
    switch (kind) {
      case "day":
        return [anchor, anchor];
      case "week":
        return [startOfWeek(anchor), endOfWeek(anchor)];
      case "month":
        return [startOfMonth(anchor), endOfMonth(anchor)];
      case "year":
        return [startOfYear(anchor), endOfYear(anchor)];
      default:
        return customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
    }
  }, [kind, anchor, customFrom, customTo]);

  const { data: summary, isLoading } = useSWR<{ days: DaySummary[] }>(open ? `/api/calendar?from=${from}&to=${to}` : null, fetcher, {
    keepPreviousData: false,
  });
  const count = summary?.days.reduce((s, d) => s + d.count, 0) ?? 0;
  const durationMs = summary?.days.reduce((s, d) => s + d.durationMs, 0) ?? 0;

  const { y, m } = parseYmd(anchor);
  const thisYear = parseYmd(today).y;
  const years = Array.from({ length: 8 }, (_, i) => thisYear - i);
  const months = Array.from({ length: 12 }, (_, i) => capitalize(fmtMonthName(ymdOf(2024, i + 1, 1), locale)));

  const setDate = (value: string, apply: (d: Ymd) => void) => {
    if (isValidYmd(value)) apply(value);
  };

  const create = async () => {
    if (!options) return;
    setBusy(true);
    try {
      const res = await api<{ film: FilmDto }>("/api/films", {
        body: { kind, dateFrom: from, dateTo: to, variant, ...options },
      });
      onClose();
      // Фильм собирается на этом устройстве — сразу открываем экран сборки.
      router.push(renderHref(res.film.id));
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={f.create}
      tall
      locked={busy}
      footer={
        <Button size="lg" block loading={busy} disabled={count === 0 || !options} icon={<Clapperboard aria-hidden="true" size={20} />} onClick={() => void create()}>
          {f.start}
        </Button>
      }
    >
      <div className="flex flex-col gap-5 pb-2">
        <div>
          <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{f.period}</p>
          <Segmented<Kind>
            label={f.period}
            size="sm"
            value={kind}
            onChange={setKind}
            options={(["day", "week", "month", "year", "custom"] as const).map((k) => ({ value: k, label: f.kinds[k] }))}
          />
        </div>

        {(kind === "day" || kind === "week") && (
          <div>
            <label htmlFor="film-date" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
              {f.date}
            </label>
            <input id="film-date" type="date" max={today} value={anchor} onChange={(e) => setDate(e.target.value, setAnchor)} className={dateInput} />
            {kind === "week" && <p className="t-caption mt-1.5">{f.weekHint(fmtRange(from, to, locale))}</p>}
          </div>
        )}

        {(kind === "month" || kind === "year") && (
          <div className="flex gap-3">
            {kind === "month" && (
              <div className="flex-1">
                <label htmlFor="film-month" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                  {f.month}
                </label>
                <select id="film-month" value={m} onChange={(e) => setAnchor(ymdOf(y, Number(e.target.value), 1))} className={dateInput}>
                  {months.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1">
              <label htmlFor="film-year" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                {f.year}
              </label>
              <select id="film-year" value={y} onChange={(e) => setAnchor(ymdOf(Number(e.target.value), m, 1))} className={dateInput}>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {kind === "custom" && (
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="film-from" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                {f.from}
              </label>
              <input id="film-from" type="date" max={today} value={customFrom} onChange={(e) => setDate(e.target.value, setCustomFrom)} className={dateInput} />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor="film-to" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                {f.to}
              </label>
              <input id="film-to" type="date" max={today} value={customTo} onChange={(e) => setDate(e.target.value, setCustomTo)} className={dateInput} />
            </div>
          </div>
        )}

        <div
          role="status"
          className={`rounded-[18px] px-4 py-3 text-[15px] font-semibold ${
            count > 0 ? "bg-lime-soft text-leaf-deep" : "bg-ink/6 text-muted-strong"
          }`}
        >
          {isLoading && !summary ? t.common.loading : count > 0 ? f.periodMoments(count, durationMs) : f.periodEmpty}
        </div>

        <div>
          <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{f.version}</p>
          <Segmented<"full" | "highlights">
            label={f.version}
            value={variant}
            onChange={setVariant}
            options={[
              { value: "full", label: f.variantFull },
              { value: "highlights", label: f.variantHighlights },
            ]}
          />
          <p className="t-caption mt-2">{variant === "full" ? f.variantFullHint : f.variantHighlightsHint}</p>
        </div>

        <div className="glass overflow-hidden">
          <button
            type="button"
            aria-expanded={lookOpen}
            onClick={() => setLookOpen((v) => !v)}
            className="flex min-h-[56px] w-full items-center justify-between px-4 text-left text-[16px] font-semibold"
          >
            {f.look}
            <ChevronDown aria-hidden="true" size={20} className={`transition-transform duration-300 ${lookOpen ? "rotate-180" : ""}`} />
          </button>
          {lookOpen && options && (
            <div className="px-4 pb-5 pt-1">
              <FilmOptionsFields value={options} onChange={(patch) => setOptions((prev) => (prev ? { ...prev, ...patch } : prev))} />
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
