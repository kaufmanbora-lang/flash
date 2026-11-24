"use client";

import { CalendarDays, Clapperboard, FolderPlus, Pause, Play, Plus, Video } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { errorText, fetcher } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useHome, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { Page, Reveal, TitleHeader } from "@/components/app/Page";
import { CreateFilmSheet } from "@/components/films/CreateFilmSheet";
import { FilmCard, isRendering } from "@/components/films/FilmCard";
import { ProjectCover, projectDates, projectDayLabel } from "@/components/projects/ProjectParts";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { Badge, EmptyState, LoadError, ProgressBar, SectionTitle, Skeleton } from "@/components/ui/Feedback";
import { fmtDayMonth } from "@/lib/format";
import type { FilmDto, ProjectDto } from "@/lib/types";

type Tab = "films" | "projects";

function ProjectRow({ project }: { project: ProjectDto }) {
  const t = useT();
  const { locale } = useLocale();
  const pr = project.progress;
  // Идущему проекту важнее, когда он закончится («до 6 декабря»); полный период виден на его странице.
  const tail = pr.started && pr.expectedEnd ? t.project.until(fmtDayMonth(pr.expectedEnd, locale)) : projectDates(project, locale, t);
  return (
    <Link href={`/project?id=${project.id}`} onClick={() => haptic("light")} className="glass press flex items-center gap-3.5 p-2.5 pr-4">
      <ProjectCover cover={project.cover} shade={false} className="size-[84px] shrink-0 rounded-[20px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-serif text-[22px] font-semibold leading-none">{project.title}</span>
        <span className="mt-1.5 flex items-start gap-1.5 text-[13.5px] leading-snug text-muted-strong">
          {project.status === "paused" && <Pause aria-hidden="true" size={12} fill="currentColor" strokeWidth={0} className="mt-[3px] shrink-0" />}
          <span>
            {project.status === "paused" ? t.project.paused : projectDayLabel(project, t)} · {tail}
          </span>
        </span>
        {pr.percent !== null && <ProgressBar value={pr.percent} label={t.project.progressAria} className="mt-2.5 h-2" />}
      </span>
    </Link>
  );
}

/** Завершённый проект как афиша на полке личной коллекции. */
function ProjectPoster({ project }: { project: ProjectDto }) {
  const t = useT();
  const { locale } = useLocale();
  const film = project.film;
  return (
    <Link href={`/project?id=${project.id}`} onClick={() => haptic("light")} className="press block">
      <ProjectCover cover={project.cover} className="aspect-[4/5] rounded-[24px] shadow-float ring-1 ring-white/70">
        <div className="flex h-full flex-col justify-end p-3.5 text-white">
          <h3 className="line-clamp-3 font-serif text-[24px] font-semibold leading-[0.98] [text-shadow:0_2px_14px_rgb(0_0_0/0.4)]">{project.title}</h3>
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-white/90">
            <CalendarDays aria-hidden="true" size={13} />
            <span className="truncate">{projectDates(project, locale, t)}</span>
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold">
            {film ? (
              <>
                <span className="grid size-6 place-items-center rounded-full bg-white/30">
                  <Play aria-hidden="true" size={10} fill="currentColor" strokeWidth={0} className="ml-px" />
                </span>
                {t.fmt.duration(film.durationMs)}
              </>
            ) : project.momentsCount > 0 ? (
              t.project.filmPending
            ) : (
              t.project.noFilm
            )}
          </p>
        </div>
      </ProjectCover>
    </Link>
  );
}

function FilmsContent() {
  const t = useT();
  const f = t.films;
  const router = useRouter();
  const today = useToday();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "projects" ? "projects" : "films");
  const [creating, setCreating] = useState(false);
  const { data: home } = useHome();

  const {
    data: filmsData,
    error: filmsError,
    mutate: reloadFilms,
  } = useSWR<{ films: FilmDto[] }>("/api/films", fetcher);
  const {
    data: projectsData,
    error: projectsError,
    mutate: reloadProjects,
  } = useSWR<{ projects: ProjectDto[] }>(tab === "projects" ? `/api/projects?today=${today}` : null, fetcher);

  const films = filmsData?.films ?? [];
  const working = films.filter((x) => isRendering(x) && !x.hasFile);
  const rest = films.filter((x) => !working.includes(x));
  const open = (projectsData?.projects ?? []).filter((p) => p.status !== "completed");
  const done = (projectsData?.projects ?? []).filter((p) => p.status === "completed");
  const hasMoments = (home?.totals.moments ?? 0) > 0;

  return (
    <Page>
      <TitleHeader
        title={f.title}
        actions={
          <IconButton label={tab === "films" ? f.create : t.project.create} onClick={() => (tab === "films" ? setCreating(true) : router.push("/projects/new"))}>
            <Plus aria-hidden="true" size={23} strokeWidth={2.2} />
          </IconButton>
        }
      />
      <Segmented<Tab>
        label={f.title}
        value={tab}
        onChange={setTab}
        options={[
          { value: "films", label: f.tabs.films },
          { value: "projects", label: f.tabs.projects },
        ]}
      />

      <div className="mt-5">
        {tab === "films" && (
          <>
            {!filmsData && !filmsError && (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-[112px] rounded-[28px]" />
                <Skeleton className="h-[112px] rounded-[28px]" />
                <Skeleton className="h-[112px] rounded-[28px]" />
              </div>
            )}
            {!filmsData && filmsError && <LoadError message={errorText(t, filmsError)} onRetry={() => void reloadFilms()} />}
            {filmsData && films.length === 0 && (
              <EmptyState
                icon={<Clapperboard aria-hidden="true" size={28} strokeWidth={1.7} />}
                title={f.emptyTitle}
                text={f.emptyText}
                action={
                  hasMoments ? (
                    <Button icon={<Clapperboard aria-hidden="true" size={18} />} onClick={() => setCreating(true)}>
                      {f.create}
                    </Button>
                  ) : (
                    <Button icon={<Video aria-hidden="true" size={18} />} onClick={() => router.push("/record")}>
                      {f.recordFirst}
                    </Button>
                  )
                }
              />
            )}
            {films.length > 0 && (
              <div className="flex flex-col gap-6">
                {working.length > 0 && (
                  <Reveal>
                    <SectionTitle>{f.waitingSection}</SectionTitle>
                    <div className="flex flex-col gap-3">
                      {working.map((film) => (
                        <FilmCard key={film.id} film={film} />
                      ))}
                    </div>
                  </Reveal>
                )}
                {rest.length > 0 && (
                  <Reveal delay={1}>
                    <div className="flex flex-col gap-3">
                      {rest.map((film) => (
                        <FilmCard key={film.id} film={film} />
                      ))}
                    </div>
                  </Reveal>
                )}
                <Button variant="glass" block icon={<Plus aria-hidden="true" size={18} />} onClick={() => setCreating(true)}>
                  {f.createShort}
                </Button>
              </div>
            )}
          </>
        )}

        {tab === "projects" && (
          <>
            {!projectsData && !projectsError && (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-[104px] rounded-[28px]" />
                <Skeleton className="h-[104px] rounded-[28px]" />
              </div>
            )}
            {!projectsData && projectsError && <LoadError message={errorText(t, projectsError)} onRetry={() => void reloadProjects()} />}
            {projectsData && open.length + done.length === 0 && (
              <EmptyState
                icon={<FolderPlus aria-hidden="true" size={28} strokeWidth={1.7} />}
                title={t.project.emptyTitle}
                text={t.project.emptyText}
                action={
                  <Button icon={<Plus aria-hidden="true" size={18} />} onClick={() => router.push("/projects/new")}>
                    {t.project.create}
                  </Button>
                }
              />
            )}
            {projectsData && open.length + done.length > 0 && (
              <div className="flex flex-col gap-7">
                <Reveal>
                  {open.length > 0 && <SectionTitle>{t.project.active}</SectionTitle>}
                  <div className="flex flex-col gap-3">
                    {open.map((p) => (
                      <ProjectRow key={p.id} project={p} />
                    ))}
                    <Button variant="glass" block icon={<Plus aria-hidden="true" size={18} />} onClick={() => router.push("/projects/new")}>
                      {t.project.create}
                    </Button>
                  </div>
                </Reveal>
                {done.length > 0 && (
                  <Reveal delay={1}>
                    <div className="mb-3 px-1">
                      <div className="flex items-center gap-2">
                        <h2 className="t-section">{t.project.collection}</h2>
                        <Badge>{done.length}</Badge>
                      </div>
                      <p className="t-caption mt-0.5">{t.project.collectionHint}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {done.map((p) => (
                        <ProjectPoster key={p.id} project={p} />
                      ))}
                    </div>
                  </Reveal>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <CreateFilmSheet open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

export default function FilmsPage() {
  // useSearchParams требует границы Suspense при статической сборке страницы.
  return (
    <Suspense fallback={null}>
      <FilmsContent />
    </Suspense>
  );
}
