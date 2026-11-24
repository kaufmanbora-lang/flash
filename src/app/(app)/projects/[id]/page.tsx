"use client";

import {
  CalendarDays,
  CheckCircle2,
  Clapperboard,
  FolderOpen,
  MoreHorizontal,
  Palette,
  Pause,
  RefreshCw,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { api, ApiError, codeText, errorText, fetcher } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useDrafts, useHome, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { BackHeader, Page, Reveal } from "@/components/app/Page";
import { isRendering } from "@/components/films/FilmCard";
import { FilmOptionsFields } from "@/components/films/FilmOptions";
import { FilmActionTiles } from "@/components/films/FilmActionTiles";
import { FilmShareSheet } from "@/components/films/FilmShareSheet";
import { MomentThumb } from "@/components/moments/MomentThumb";
import { MomentViewer } from "@/components/moments/MomentViewer";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { ManageSheet, type ProjectPatch } from "@/components/projects/ManageSheet";
import { DayGrid, ProjectCover, projectDates, ProjectProgressCard, ProjectStats } from "@/components/projects/ProjectParts";
import { VariantPicker } from "@/components/projects/VariantPicker";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, EmptyState, ProgressBar, SectionTitle, Skeleton } from "@/components/ui/Feedback";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { MAX_MOMENTS_PER_DAY, type ProjectVariant } from "@/lib/constants";
import { fmtDayMonthShort } from "@/lib/format";
import type { FilmDto, FilmOptions, MomentDto, ProjectDetailDto } from "@/lib/types";

/** Какую версию показать первой: готовую «старшую», иначе ту, что уже можно собрать. */
function defaultVariant(project: ProjectDetailDto): ProjectVariant {
  const order: ProjectVariant[] = ["full", "extended", "mini", "trailer"];
  const ready = order.find((v) => project.variants.find((x) => x.variant === v)?.film?.hasFile);
  if (ready) return ready;
  const working = order.find((v) => {
    const film = project.variants.find((x) => x.variant === v)?.film;
    return film && isRendering(film);
  });
  return working ?? "full";
}

export default function ProjectPage() {
  const t = useT();
  const pp = t.projectPage;
  const toast = useToast();
  const router = useRouter();
  const today = useToday();
  const { locale } = useLocale();
  const { mutate: mutateAll } = useSWRConfig();
  const { id } = useParams<{ id: string }>();
  const drafts = useDrafts();
  const { data: home } = useHome();

  const { data, error, mutate } = useSWR<{ project: ProjectDetailDto }>(`/api/projects/${id}?today=${today}`, fetcher, {
    refreshInterval: (d) => {
      if (!d) return 0;
      const busy = d.project.variants.some((v) => v.film && isRendering(v.film)) || d.project.moments.some((m) => m.status === "processing");
      return busy ? 2000 : 0;
    },
  });
  const project = data?.project;

  const [variant, setVariant] = useState<ProjectVariant | null>(null);
  const [manage, setManage] = useState(false);
  const [look, setLook] = useState(false);
  const [options, setOptions] = useState<FilmOptions | null>(null);
  const [share, setShare] = useState<FilmDto | null>(null);
  const [viewing, setViewing] = useState<MomentDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllDays, setShowAllDays] = useState(false);

  useEffect(() => {
    if (project && variant === null) setVariant(defaultVariant(project));
  }, [project, variant]);
  useEffect(() => {
    if (project && !look) setOptions(project.filmSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, look]);

  const refreshLists = () =>
    mutateAll((key) => typeof key === "string" && (key.startsWith("/api/projects") || key.startsWith("/api/home") || key.startsWith("/api/films")));

  const patch = async (body: ProjectPatch, message: string): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api<{ project: ProjectDetailDto }>(`/api/projects/${id}`, { method: "PATCH", body: { today, ...body } });
      await mutate(res, { revalidate: false });
      void refreshLists();
      toast(message, "success");
      return true;
    } catch (err) {
      toast(errorText(t, err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (deleteFilms: boolean) => {
    setBusy(true);
    try {
      await api(`/api/projects/${id}${deleteFilms ? "?films=delete" : ""}`, { method: "DELETE" });
      void refreshLists();
      toast(pp.deleted, "success");
      router.replace("/films?tab=projects");
    } catch (err) {
      toast(errorText(t, err), "error");
      setBusy(false);
    }
  };

  const createFilm = async (v: ProjectVariant) => {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/films`, { body: { variant: v } });
      await mutate();
      void refreshLists();
      haptic("success");
      toast(t.films.queued, "success");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  // Длинные проекты: по умолчанию показываем окно вокруг сегодняшнего дня.
  const visibleDays = useMemo(() => {
    const days = project?.days ?? [];
    if (showAllDays || days.length <= 60) return days;
    const idx = Math.max(0, days.findIndex((d) => d.date >= today));
    const from = Math.max(0, Math.min(days.length - 40, (idx === -1 ? days.length : idx) - 29));
    return days.slice(from, from + 40);
  }, [project?.days, showAllDays, today]);

  if (!project) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page>
        <BackHeader fallback="/films?tab=projects" />
        {error ? (
          <EmptyState
            icon={<FolderOpen aria-hidden="true" size={26} strokeWidth={1.8} />}
            title={missing ? pp.notFound : t.common.loadFailed}
            text={missing ? undefined : errorText(t, error)}
            action={
              <Button variant="glass" size="sm" onClick={() => (missing ? router.replace("/films?tab=projects") : void mutate())}>
                {missing ? t.common.back : t.common.retry}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4 pt-2" aria-hidden="true">
            <Skeleton className="aspect-[1.7/1] w-full rounded-[28px]" />
            <Skeleton className="h-[110px] rounded-[28px]" />
            <Skeleton className="h-[150px] rounded-[28px]" />
          </div>
        )}
      </Page>
    );
  }

  const completed = project.status === "completed";
  const selected = project.variants.find((v) => v.variant === variant) ?? project.variants[project.variants.length - 1];
  const film = selected.film;
  const filmRendering = !!film && isRendering(film);
  const anyReady = project.variants.some((v) => v.film?.hasFile);
  const todayPending = drafts.filter((d) => d.localDate === today && d.state !== "failed").length;
  const todayFull = (home?.today.count ?? 0) + todayPending >= MAX_MOMENTS_PER_DAY;
  const canRecord = project.status === "active" && project.progress.started;
  const pct = Math.round((film?.progress ?? 0) * 100);

  return (
    <Page>
      <BackHeader
        fallback="/films?tab=projects"
        actions={
          <IconButton label={pp.manage} onClick={() => setManage(true)}>
            <MoreHorizontal aria-hidden="true" size={22} />
          </IconButton>
        }
      />

      {completed && anyReady ? (
        <Reveal className="pb-4 pt-2">
          <Badge icon={<CheckCircle2 aria-hidden="true" size={14} />}>{pp.statusCompleted}</Badge>
          <h1 className="t-display mt-3">{pp.filmReady}</h1>
          <p className="mt-1.5 font-serif text-[26px] font-semibold leading-none text-muted-strong">{project.title}</p>
          <p className="mt-2.5 flex items-center gap-2 text-[15px] text-muted-strong">
            <CalendarDays aria-hidden="true" size={17} />
            {projectDates(project, locale, t)}
          </p>
        </Reveal>
      ) : (
        <Reveal className="pb-4 pt-2">
          <ProjectCover cover={project.cover} className="aspect-[1.75/1] rounded-[28px] shadow-float ring-1 ring-white/70">
            <div className="flex h-full flex-col justify-end p-5 text-white">
              <span className="mb-auto inline-flex w-fit items-center gap-1.5 rounded-full bg-white/25 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] backdrop-blur-md">
                {project.status === "paused" && <Pause aria-hidden="true" size={11} fill="currentColor" strokeWidth={0} />}
                {completed ? pp.statusCompleted : project.status === "paused" ? pp.statusPaused : project.progress.started ? pp.statusActive : pp.statusScheduled}
              </span>
              <h1 className="line-clamp-3 font-serif text-[clamp(2rem,9vw,2.75rem)] font-semibold leading-[0.98] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)]">
                {project.title}
              </h1>
              <p className="mt-2 flex items-center gap-2 text-[14.5px] font-medium text-white/92">
                <CalendarDays aria-hidden="true" size={16} />
                {projectDates(project, locale, t)}
              </p>
            </div>
          </ProjectCover>
          {project.description && <p className="mt-3 px-1 text-[15.5px] leading-snug text-muted-strong">{project.description}</p>}
        </Reveal>
      )}

      <div className="flex flex-col gap-4">
        {!completed && (
          <Reveal delay={1}>
            <ProjectProgressCard project={project} />
          </Reveal>
        )}

        {!completed && (
          <Reveal delay={2} className="glass p-5">
            <div className="mb-3.5 flex items-center justify-between gap-3">
              <h2 className="t-section">{t.project.calendar}</h2>
              {project.days.length > 60 && (
                <button type="button" onClick={() => setShowAllDays((v) => !v)} className="press min-h-[36px] rounded-full px-2 text-[13.5px] font-semibold text-leaf-deep">
                  {showAllDays ? pp.calendarLess : pp.calendarAll}
                </button>
              )}
            </div>
            <DayGrid days={visibleDays} today={today} />
          </Reveal>
        )}

        <Reveal delay={3}>
          <ProjectStats project={project} />
        </Reveal>

        {canRecord && (
          <Reveal delay={4}>
            {todayFull ? (
              <div className="glass flex min-h-[68px] items-center justify-center gap-2.5 rounded-full px-6 text-[15.5px] font-semibold text-muted-strong">
                <CheckCircle2 aria-hidden="true" size={20} className="text-leaf-deep" />
                {pp.recordFull}
              </div>
            ) : (
              <Link href="/record" onClick={() => haptic("medium")} className="btn-lime sheen press flex min-h-[68px] items-center justify-center gap-3 rounded-full px-6 text-[19px] font-semibold tracking-[-0.02em]">
                <Video aria-hidden="true" size={24} strokeWidth={1.9} />
                {pp.record}
              </Link>
            )}
          </Reveal>
        )}

        {/* ── Фильм проекта ─────────────────────────────────── */}
        <Reveal delay={5} className="pt-2">
          <SectionTitle>{pp.formats}</SectionTitle>
          <VariantPicker variants={project.variants} selected={selected.variant} onSelect={setVariant} />

          <div className="mt-4 flex flex-col gap-3">
            {film?.hasFile && film.videoUrl ? (
              <>
                <VideoPlayer
                  key={film.videoUrl}
                  src={film.videoUrl}
                  poster={film.posterUrl}
                  title={`${project.title} — ${t.film.variants[selected.variant]}`}
                  width={film.width || 9}
                  height={film.height || 16}
                  chapters={film.chapters}
                  maxHeight="60dvh"
                />
                {filmRendering && (
                  <div className="glass px-5 py-4" role="status">
                    <div className="flex items-baseline justify-between text-[15px] font-semibold">
                      <span>{t.films.updating}</span>
                      <span className="tabular text-leaf-deep">{pct}%</span>
                    </div>
                    <ProgressBar value={pct} label={t.films.renderingAria(pct)} className="mt-2.5" />
                  </div>
                )}
                {film.stale && !filmRendering && (
                  <div className="glass glass-tint flex items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15.5px] font-semibold leading-tight">{t.films.staleTitle}</p>
                      <p className="mt-0.5 text-[13px] text-ink/70">{t.films.staleText}</p>
                    </div>
                    <Button size="sm" loading={busy} onClick={() => void createFilm(selected.variant)}>
                      {t.films.update}
                    </Button>
                  </div>
                )}
                <FilmActionTiles film={film} onShare={() => setShare(film)} />
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="glass" icon={<Clapperboard aria-hidden="true" size={17} />} onClick={() => router.push(`/films/${film.id}`)}>
                    {pp.openFilm}
                  </Button>
                  <Button variant="glass" disabled={filmRendering} loading={busy} icon={<RefreshCw aria-hidden="true" size={17} />} onClick={() => void createFilm(selected.variant)}>
                    {t.films.rerender}
                  </Button>
                </div>
              </>
            ) : filmRendering && film ? (
              <div className="glass px-5 py-5" role="status">
                <div className="flex items-baseline justify-between text-[16px] font-semibold">
                  <span aria-live="polite">{film.status === "queued" ? t.films.status.queued : (t.films.stages[film.stage] ?? t.films.status.rendering)}</span>
                  <span className="tabular text-leaf-deep">{pct}%</span>
                </div>
                <ProgressBar value={pct} label={t.films.renderingAria(pct)} className="mt-3" />
                <p className="t-caption mt-2.5">{t.films.progressHint}</p>
              </div>
            ) : (
              <div className="glass px-5 py-5">
                <p className="text-[15px] leading-snug text-muted-strong">
                  {film?.status === "failed"
                    ? codeText(t, film.error ?? "render_failed")
                    : selected.available
                      ? pp.variantHints[selected.variant]
                      : selected.variant === "full"
                        ? pp.needMomentsHint
                        : pp.variantLockedHint(t.fmt.duration(selected.needSec * 1000))}
                </p>
                {selected.available && (
                  <Button block className="mt-4" loading={busy} icon={<Clapperboard aria-hidden="true" size={18} />} onClick={() => void createFilm(selected.variant)}>
                    {pp.createVariant(t.film.variants[selected.variant])}
                  </Button>
                )}
                {!completed && selected.available && <p className="t-caption mt-3">{pp.interimHint}</p>}
              </div>
            )}
          </div>

          <button type="button" onClick={() => setLook(true)} className="glass press mt-3 flex min-h-[64px] w-full items-center gap-3.5 px-4 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lime-soft text-leaf-deep">
              <Palette aria-hidden="true" size={19} />
            </span>
            <span className="min-w-0">
              <span className="block text-[16px] font-semibold leading-tight">{pp.look}</span>
              <span className="t-caption block truncate">{pp.lookHint}</span>
            </span>
          </button>
        </Reveal>

        {/* ── Моменты ───────────────────────────────────────── */}
        <Reveal delay={6} className="pt-2">
          <SectionTitle>{pp.moments}</SectionTitle>
          {project.moments.length === 0 ? (
            <EmptyState icon={<Video aria-hidden="true" size={26} strokeWidth={1.8} />} title={pp.momentsEmpty} text={canRecord ? pp.momentsEmptyHint : undefined} />
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {project.moments.map((m) => (
                <MomentThumb key={m.id} moment={m} caption={fmtDayMonthShort(m.date, locale)} onClick={() => setViewing(m)} className="w-full" />
              ))}
            </div>
          )}
        </Reveal>
      </div>

      <ManageSheet project={project} today={today} open={manage} onClose={() => setManage(false)} onPatch={patch} onDelete={remove} busy={busy} />

      <Sheet
        open={look}
        onClose={() => setLook(false)}
        title={pp.look}
        description={pp.lookHint}
        tall
        locked={busy}
        footer={
          <Button
            size="lg"
            block
            loading={busy}
            onClick={async () => {
              if (options && (await patch({ filmSettings: options }, pp.lookSaved))) setLook(false);
            }}
          >
            {t.common.save}
          </Button>
        }
      >
        {options && <FilmOptionsFields value={options} onChange={(p) => setOptions((prev) => (prev ? { ...prev, ...p } : prev))} />}
      </Sheet>

      {share && <FilmShareSheet film={share} open onClose={() => setShare(null)} />}
      <MomentViewer
        moment={viewing}
        onClose={() => {
          setViewing(null);
          void mutate();
        }}
      />
    </Page>
  );
}
