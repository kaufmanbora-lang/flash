"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clapperboard,
  Clock3,
  FolderOpen,
  MoreHorizontal,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { api, ApiError, codeText, errorText, fetcher } from "@/client/api";
import { useLocale, useT } from "@/client/i18n";
import { BackHeader, Page, Reveal } from "@/components/app/Page";
import { isRendering, qualityLabel } from "@/components/films/FilmCard";
import { FilmOptionsFields } from "@/components/films/FilmOptions";
import { FilmActionTiles } from "@/components/films/FilmActionTiles";
import { FilmShareSheet } from "@/components/films/FilmShareSheet";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { Button, IconButton } from "@/components/ui/Button";
import { Row } from "@/components/ui/Controls";
import { Badge, EmptyState, ProgressBar, Ring, Skeleton } from "@/components/ui/Feedback";
import { ConfirmSheet, Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { FILM_STYLE_NAMES, MUSIC_STYLE_NAMES, type MusicStyleId } from "@/lib/constants";
import { diffDays } from "@/lib/dates";
import { fmtClock, fmtDayMonth, fmtFullDate, fmtRange } from "@/lib/format";
import type { FilmDto, FilmOptions, MusicTrackDto } from "@/lib/types";

function optionsOf(film: FilmDto): FilmOptions {
  return {
    style: film.style,
    music: film.music,
    musicVolume: film.musicVolume,
    orientation: film.orientation,
    resolution: film.resolution,
  };
}

export default function FilmPage() {
  const t = useT();
  const f = t.films;
  const toast = useToast();
  const router = useRouter();
  const { locale } = useLocale();
  const { mutate: mutateAll } = useSWRConfig();
  const { id } = useParams<{ id: string }>();

  const { data, error, mutate } = useSWR<{ film: FilmDto }>(`/api/films/${id}`, fetcher, {
    refreshInterval: (d) => (d && isRendering(d.film) ? 1500 : 0),
  });
  const { data: music } = useSWR<{ tracks: MusicTrackDto[] }>("/api/music", fetcher, { revalidateOnFocus: false });

  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [rerender, setRerender] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [options, setOptions] = useState<FilmOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [playNonce, setPlayNonce] = useState(0);

  const film = data?.film;
  useEffect(() => {
    if (film && !rerender) setOptions(optionsOf(film));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [film?.id, film?.style, film?.music, film?.musicVolume, rerender]);

  const refreshLists = () =>
    mutateAll((key) => typeof key === "string" && (key.startsWith("/api/films") || key.startsWith("/api/home") || key.startsWith("/api/projects")));

  const startRender = async (opts: Partial<FilmOptions>) => {
    setBusy(true);
    try {
      const res = await api<{ film: FilmDto }>(`/api/films/${id}`, { method: "PATCH", body: opts });
      await mutate(res, { revalidate: false });
      void refreshLists();
      setRerender(false);
      toast(f.queued, "success");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/films/${id}`, { method: "DELETE" });
      void refreshLists();
      toast(f.deleted, "success");
      router.replace("/films");
    } catch (err) {
      toast(errorText(t, err), "error");
      setBusy(false);
    }
  };

  if (!film) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page>
        <BackHeader fallback="/films" />
        {error ? (
          <EmptyState
            icon={<Clapperboard aria-hidden="true" size={26} strokeWidth={1.8} />}
            title={missing ? f.notFound : t.common.loadFailed}
            text={missing ? undefined : errorText(t, error)}
            action={
              <Button variant="glass" size="sm" onClick={() => (missing ? router.replace("/films") : void mutate())}>
                {missing ? t.common.back : t.common.retry}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4 pt-2" aria-hidden="true">
            <Skeleton className="h-8 w-40 rounded-full" />
            <Skeleton className="h-12 w-4/5" />
            <Skeleton className="aspect-[9/14] w-full rounded-[28px]" />
          </div>
        )}
      </Page>
    );
  }

  const rendering = isRendering(film);
  const pct = Math.round(film.progress * 100);
  const stageText = film.status === "queued" ? f.status.queued : (f.stages[film.stage] ?? f.status.rendering);
  const days = diffDays(film.dateTo, film.dateFrom) + 1;
  const dates = film.dateFrom === film.dateTo ? fmtFullDate(film.dateFrom, locale) : fmtRange(film.dateFrom, film.dateTo, locale);
  const trackNames = film.musicTracks
    .map((trackId) => music?.tracks.find((tr) => tr.id === trackId))
    .filter((tr): tr is MusicTrackDto => !!tr);
  const musicText =
    trackNames.length > 0
      ? `${MUSIC_STYLE_NAMES[trackNames[0].style as MusicStyleId] ?? ""} · ${[...new Set(trackNames.map((tr) => `«${tr.title}»`))].slice(0, 3).join(", ")}`
      : film.hasFile
        ? f.info.noMusic
        : "—";

  return (
    <Page>
      <BackHeader
        fallback={film.projectId ? `/projects/${film.projectId}` : "/films"}
        actions={
          <IconButton label={f.more} onClick={() => setMenu(true)}>
            <MoreHorizontal aria-hidden="true" size={22} />
          </IconButton>
        }
      />

      <Reveal className="pb-4 pt-2">
        <div className="flex flex-wrap gap-2">
          {film.hasFile && !rendering && (
            <Badge icon={<CheckCircle2 aria-hidden="true" size={14} />}>{film.auto ? f.auto : f.status.ready}</Badge>
          )}
          {rendering && <Badge icon={<Sparkles aria-hidden="true" size={13} />}>{film.hasFile ? f.updating : f.status.rendering}</Badge>}
          {film.status === "failed" && (
            <Badge tone="danger" icon={<AlertTriangle aria-hidden="true" size={13} />}>
              {f.status.failed}
            </Badge>
          )}
          <Badge tone="muted">{t.film.variants[film.variant]}</Badge>
        </div>
        <h1 className="t-display mt-3">{film.title}</h1>
        <p className="mt-2 flex items-center gap-2 text-[15px] text-muted-strong">
          <CalendarDays aria-hidden="true" size={17} />
          {film.kind === "day" ? film.subtitle : dates}
        </p>
      </Reveal>

      <div className="flex flex-col gap-4">
        {film.hasFile && film.videoUrl ? (
          <Reveal delay={1}>
            <VideoPlayer
              key={`${film.videoUrl}-${playNonce}`}
              src={film.videoUrl}
              poster={film.posterUrl}
              title={film.title}
              width={film.width || 9}
              height={film.height || 16}
              chapters={film.chapters}
              autoPlay={playNonce > 0}
              maxHeight="62dvh"
            />
          </Reveal>
        ) : rendering ? (
          <Reveal delay={1} className="glass flex flex-col items-center px-6 py-9 text-center">
            <Ring value={film.progress} size={156} stroke={10} label={f.renderingAria(pct)}>
              <span className="tabular text-[38px] font-bold tracking-[-0.04em]">
                {pct}
                <span className="text-[20px]">%</span>
              </span>
            </Ring>
            <p className="mt-5 text-[18px] font-semibold tracking-[-0.015em]" aria-live="polite">
              {stageText}
            </p>
            <p className="mt-1.5 max-w-[30ch] text-[14.5px] leading-snug text-muted-strong">{f.progressHint}</p>
          </Reveal>
        ) : (
          <Reveal delay={1} className="glass px-6 py-8 text-center">
            <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-danger-soft text-danger">
              <AlertTriangle aria-hidden="true" size={28} />
            </span>
            <h2 className="t-section">{f.failedTitle}</h2>
            <p className="mt-1.5 text-[15px] text-muted-strong">{codeText(t, film.error ?? "render_failed")}</p>
            <Button className="mt-5" loading={busy} icon={<RefreshCw aria-hidden="true" size={18} />} onClick={() => void startRender({})}>
              {t.common.retry}
            </Button>
          </Reveal>
        )}

        {rendering && film.hasFile && (
          <div className="glass px-5 py-4" role="status">
            <div className="flex items-baseline justify-between text-[15px] font-semibold">
              <span>{f.updating}</span>
              <span className="tabular text-leaf-deep">{pct}%</span>
            </div>
            <ProgressBar value={pct} label={f.renderingAria(pct)} className="mt-2.5" />
            <p className="t-caption mt-2">{stageText}</p>
          </div>
        )}

        {film.status === "ready" && film.error && (
          <div className="rounded-[20px] bg-danger-soft px-4 py-3 text-[14.5px] font-medium text-danger" role="alert">
            {codeText(t, film.error)}
          </div>
        )}

        {film.stale && !rendering && film.hasFile && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass glass-tint flex items-center gap-3 p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-white/75 text-leaf-deep">
              <Sparkles aria-hidden="true" size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15.5px] font-semibold leading-tight">{f.staleTitle}</p>
              <p className="mt-0.5 text-[13px] text-ink/70">{f.staleText}</p>
            </div>
            <Button size="sm" loading={busy} onClick={() => void startRender({})}>
              {f.update}
            </Button>
          </motion.div>
        )}

        {film.hasFile && (
          <>
            <Reveal delay={2}>
              <Button size="lg" block icon={<Play aria-hidden="true" size={20} fill="currentColor" strokeWidth={0} />} onClick={() => setPlayNonce((n) => n + 1)}>
                {f.watch}
              </Button>
            </Reveal>

            <Reveal delay={3}>
              <FilmActionTiles film={film} onShare={() => setShare(true)} />
            </Reveal>
          </>
        )}

        <Reveal delay={4} className="glass grid grid-cols-3 divide-x divide-line py-4">
          {[
            { icon: <Video aria-hidden="true" size={20} />, value: String(film.momentsCount), label: t.fmt.momentsWord(film.momentsCount) },
            { icon: <Clock3 aria-hidden="true" size={20} />, value: film.hasFile ? fmtClock(film.durationMs) : "—", label: f.stats.length },
            { icon: <CalendarDays aria-hidden="true" size={20} />, value: String(days), label: t.fmt.daysWord(days) },
          ].map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-1 px-2 text-center">
              <span className="text-leaf-deep">{stat.icon}</span>
              <span className="tabular text-[18px] font-bold leading-tight tracking-[-0.02em]">{stat.value}</span>
              <span className="t-caption text-[12px]">{stat.label}</span>
            </div>
          ))}
        </Reveal>

        {film.hasFile && (
          <Reveal delay={5} className="glass divide-y divide-line">
            <Row title={f.info.style}>
              <span className="text-[15px] font-semibold">{film.styleUsed ? FILM_STYLE_NAMES[film.styleUsed] : "—"}</span>
            </Row>
            <Row title={f.info.music} hint={musicText} />
            <Row title={f.info.quality}>
              <span className="tabular text-[15px] font-semibold">
                {qualityLabel(film)} · {film.width}×{film.height}
              </span>
            </Row>
            {film.renderedAt && (
              <Row title={f.info.rendered}>
                <span className="text-[15px] font-semibold">{fmtDayMonth(film.renderedAt.slice(0, 10), locale)}</span>
              </Row>
            )}
          </Reveal>
        )}

        {film.projectId && (
          <Link href={`/projects/${film.projectId}`} className="glass press flex min-h-[60px] items-center gap-3 px-4 text-[16px] font-semibold">
            <FolderOpen aria-hidden="true" size={20} className="text-leaf-deep" />
            {t.project.openProject}
          </Link>
        )}
      </div>

      <Sheet open={menu} onClose={() => setMenu(false)} title={film.title}>
        <div className="flex flex-col gap-3 pb-2">
          <Button
            variant="glass"
            block
            disabled={rendering}
            icon={<RefreshCw aria-hidden="true" size={18} />}
            onClick={() => {
              setMenu(false);
              setRerender(true);
            }}
          >
            {f.rerender}
          </Button>
          <Button
            variant="danger"
            block
            icon={<Trash2 aria-hidden="true" size={18} />}
            onClick={() => {
              setMenu(false);
              setConfirmDelete(true);
            }}
          >
            {f.delete}
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={rerender}
        onClose={() => setRerender(false)}
        title={f.rerenderTitle}
        description={f.rerenderHint}
        tall
        locked={busy}
        footer={
          <Button size="lg" block loading={busy} icon={<Clapperboard aria-hidden="true" size={20} />} onClick={() => options && void startRender(options)}>
            {f.rerenderStart}
          </Button>
        }
      >
        {options && <FilmOptionsFields value={options} onChange={(patch) => setOptions((prev) => (prev ? { ...prev, ...patch } : prev))} />}
      </Sheet>

      <ConfirmSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title={f.deleteTitle}
        message={f.deleteText}
        confirmLabel={t.common.delete}
        danger
        busy={busy}
      />

      <FilmShareSheet film={film} open={share} onClose={() => setShare(false)} />
    </Page>
  );
}
