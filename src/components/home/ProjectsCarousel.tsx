"use client";

import { ArrowUpRight, CalendarDays, FolderPlus } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { haptic } from "@/client/haptics";
import { useLocale, useT } from "@/client/i18n";
import { ProjectCover, projectDates, ProjectProgressCard } from "@/components/projects/ProjectParts";
import type { ProjectDto } from "@/lib/types";

/** Активные проекты на главном экране: обложка с названием и карточка прогресса. Несколько проектов листаются. */
export function ProjectsCarousel({ projects }: { projects: ProjectDto[] }) {
  const t = useT();
  const { locale } = useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const many = projects.length > 1;

  if (projects.length === 0) {
    return (
      <Link href="/projects/new" onClick={() => haptic("light")} className="glass press flex items-center gap-4 p-4">
        <span className="grid size-[54px] shrink-0 place-items-center rounded-[18px] bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">
          <FolderPlus aria-hidden="true" size={25} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold leading-tight tracking-[-0.015em]">{t.project.newTitle}</span>
          <span className="mt-1 block text-[14px] leading-snug text-muted-strong">{t.project.newText}</span>
        </span>
        <ArrowUpRight aria-hidden="true" size={20} className="shrink-0 text-leaf-deep" />
      </Link>
    );
  }

  return (
    <div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const slide = el.firstElementChild as HTMLElement | null;
          if (slide) setIndex(Math.round(el.scrollLeft / (slide.offsetWidth + 12)));
        }}
        className={many ? "no-scrollbar -mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-1" : undefined}
      >
        {projects.map((project) => (
          <Link
            key={project.id}
            href={`/project?id=${project.id}`}
            onClick={() => haptic("light")}
            aria-label={`${t.project.eyebrow}: ${project.title}`}
            className={many ? "block w-[88%] shrink-0 snap-center" : "block"}
          >
            <ProjectCover cover={project.cover} className="aspect-[1.72/1] rounded-[28px] shadow-float ring-1 ring-white/70">
              {/* Правый отступ текста оставляет место под круглую кнопку: длинное название не уходит под неё. */}
              <div className="flex h-full flex-col justify-end p-5 pr-[76px] text-white">
                <span className="mb-auto inline-flex w-fit items-center rounded-full bg-white/25 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] backdrop-blur-md">
                  {t.project.eyebrow}
                </span>
                <h3 className="line-clamp-2 font-serif text-[clamp(1.6rem,7.4vw,2.25rem)] font-semibold leading-[1.02] tracking-[-0.01em] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)]">
                  {project.title}
                </h3>
                <p className="mt-2 flex items-center gap-2 whitespace-nowrap text-[14.5px] font-medium text-white/92">
                  <CalendarDays aria-hidden="true" size={16} className="shrink-0" />
                  {projectDates(project, locale, t)}
                </p>
              </div>
              <span className="glass-dark absolute bottom-4 right-4 grid size-[50px] place-items-center rounded-full">
                <ArrowUpRight aria-hidden="true" size={22} />
              </span>
            </ProjectCover>
            <ProjectProgressCard project={project} className="mt-3" />
          </Link>
        ))}
      </div>
      {many && (
        <div className="mt-3 flex justify-center gap-1.5" aria-hidden="true">
          {projects.map((p, i) => (
            <span key={p.id} className={`h-1.5 rounded-full transition-all duration-300 ${i === index ? "w-5 bg-leaf" : "w-1.5 bg-ink/15"}`} />
          ))}
        </div>
      )}
    </div>
  );
}
