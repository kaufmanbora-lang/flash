"use client";

import clsx from "clsx";
import { AlertTriangle, ChevronRight, Clapperboard, Play } from "lucide-react";
import Link from "next/link";
import { haptic } from "@/client/haptics";
import { useLocale, useT } from "@/client/i18n";
import type { Dict } from "@/i18n";
import { addDays, type Ymd } from "@/lib/dates";
import { fmtClock, fmtDayMonth, fmtRange } from "@/lib/format";
import type { FilmDto } from "@/lib/types";

export function isRendering(film: FilmDto): boolean {
  return film.status === "queued" || film.status === "rendering";
}

export function qualityLabel(film: Pick<FilmDto, "width" | "height">): string {
  const short = Math.min(film.width, film.height);
  if (!short) return "";
  return short >= 2160 ? "4K" : short >= 1440 ? "2K" : `${short}p`;
}

/** Формат файла фильма: MP4 почти везде, WebM — если браузер не умеет кодировать H.264. */
export const formatLabel = (film: Pick<FilmDto, "mime">): string => (film.mime.includes("webm") ? "WebM" : "MP4");

/** Адрес страницы фильма. Страницы статические, поэтому идентификатор передаётся параметром. */
export const filmHref = (id: string): string => `/film?id=${id}`;
/** Адрес экрана сборки («премьеры») фильма. */
export const renderHref = (id: string): string => `/render?film=${id}`;

/** Строка под названием фильма: версия и длительность либо этап монтажа. */
export function filmMeta(t: Dict, film: FilmDto): string {
  if (isRendering(film) && !film.hasFile) return film.status === "queued" ? t.films.status.queued : t.films.status.rendering;
  if (film.status === "failed") return t.films.status.failed;
  return `${t.film.variants[film.variant]} · ${t.fmt.duration(film.durationMs)}`;
}

function Poster({ film, className }: { film: FilmDto; className?: string }) {
  return (
    <span className={clsx("relative block overflow-hidden bg-lime-soft", className)}>
      {film.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={film.posterUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center bg-gradient-to-br from-lime-soft to-lime text-leaf-deep">
          <Clapperboard aria-hidden="true" size={24} strokeWidth={1.7} />
        </span>
      )}
    </span>
  );
}

/** Строка списка фильмов. */
export function FilmCard({ film }: { film: FilmDto }) {
  const t = useT();
  const { locale } = useLocale();
  const rendering = isRendering(film);
  const dates = film.kind === "day" ? fmtDayMonth(film.dateFrom, locale) : fmtRange(film.dateFrom, film.dateTo, locale);
  return (
    <Link href={filmHref(film.id)} onClick={() => haptic("light")} className="glass press flex items-center gap-3.5 p-2.5 pr-3">
      <span className="relative shrink-0">
        <Poster film={film} className="h-[92px] w-[70px] rounded-[20px]" />
        {rendering && !film.hasFile ? (
          <span className="absolute inset-0 grid place-items-center rounded-[20px] bg-black/35 text-white">
            <Clapperboard aria-hidden="true" size={22} strokeWidth={1.8} />
          </span>
        ) : film.status === "failed" ? (
          <span className="absolute inset-0 grid place-items-center rounded-[20px] bg-black/40 text-white">
            <AlertTriangle aria-hidden="true" size={22} />
          </span>
        ) : (
          <span className="absolute bottom-1.5 left-1.5 grid size-7 place-items-center rounded-full bg-black/50 text-white">
            <Play aria-hidden="true" size={11} fill="currentColor" strokeWidth={0} className="ml-px" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="t-eyebrow block text-leaf-deep">{t.film.kinds[film.kind]}</span>
        <span className="mt-1 block truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">{film.title}</span>
        <span className={clsx("mt-1 block truncate text-[13.5px]", film.status === "failed" ? "font-medium text-danger" : "text-muted-strong")}>
          {filmMeta(t, film)}
        </span>
        {film.kind !== "day" && film.kind !== "custom" && film.kind !== "week" && (
          <span className="t-caption mt-0.5 block truncate text-[12.5px]">{dates}</span>
        )}
      </span>
      <ChevronRight aria-hidden="true" size={20} className="shrink-0 text-muted" />
    </Link>
  );
}

function relativeTitle(t: Dict, film: FilmDto, today: Ymd): string {
  if (film.kind === "day" && film.dateFrom === today) return t.home.filmToday;
  if (film.kind === "day" && film.dateFrom === addDays(today, -1)) return t.home.filmYesterday;
  return film.title;
}

/** Широкая карточка последнего фильма на главном экране. */
export function FilmHero({ film, today }: { film: FilmDto; today: Ymd }) {
  const t = useT();
  const { locale } = useLocale();
  const rendering = isRendering(film) && !film.hasFile;
  const when = film.kind === "day" ? fmtDayMonth(film.dateFrom, locale) : fmtRange(film.dateFrom, film.dateTo, locale, false);
  return (
    <Link
      href={filmHref(film.id)}
      onClick={() => haptic("light")}
      className="press relative flex min-h-[132px] items-center overflow-hidden rounded-[28px] shadow-glass ring-1 ring-white/70"
    >
      {/* Кадр фильма во всю карточку. Обёртка нужна, потому что у Poster своё позиционирование (relative). */}
      <span aria-hidden="true" className="absolute inset-0">
        <Poster film={film} className="size-full" />
      </span>
      {/* Молочная вуаль слева делает текст читаемым на любом кадре. */}
      <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-milk/95 via-milk/75 to-milk/10" />
      {/* Значки поверх кадра — без backdrop-filter: размытие над лениво загружаемой картинкой
          мешало браузеру дорисовать сам кадр. */}
      <span className="relative flex w-full items-center gap-3.5 p-4">
        <span className="grid size-[52px] shrink-0 place-items-center rounded-[18px] bg-white/85 text-leaf-deep shadow-[inset_0_1px_0_#fff,0_8px_16px_-10px_rgb(62_116_32/0.45)]">
          <Clapperboard aria-hidden="true" size={24} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] font-semibold leading-tight tracking-[-0.015em]">{relativeTitle(t, film, today)}</span>
          <span className="tabular mt-1 block truncate text-[14px] text-muted-strong">
            {rendering ? filmMeta(t, film) : `${when} · ${fmtClock(film.durationMs)}`}
          </span>
        </span>
        {rendering ? (
          <span className="btn-lime grid size-[54px] shrink-0 place-items-center rounded-full ring-2 ring-white/75">
            <Clapperboard aria-hidden="true" size={22} strokeWidth={1.9} />
          </span>
        ) : (
          <span className="btn-lime grid size-[54px] shrink-0 place-items-center rounded-full ring-2 ring-white/75">
            <Play aria-hidden="true" size={20} fill="currentColor" strokeWidth={0} className="ml-0.5" />
          </span>
        )}
      </span>
    </Link>
  );
}
