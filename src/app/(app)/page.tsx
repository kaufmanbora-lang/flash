"use client";

import { Bell, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { errorText } from "@/client/api";
import { useHome, useMe, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { BrandHeader, Page, Reveal } from "@/components/app/Page";
import { FilmHero } from "@/components/films/FilmCard";
import { ActivityCard, OnThisDay } from "@/components/home/ActivityParts";
import { Onboarding } from "@/components/home/Onboarding";
import { ProjectsCarousel } from "@/components/home/ProjectsCarousel";
import { RecordButton, TodaySlots, TodayStats } from "@/components/home/TodayParts";
import { MomentThumb } from "@/components/moments/MomentThumb";
import { MomentViewer } from "@/components/moments/MomentViewer";
import { IconButton } from "@/components/ui/Button";
import { LoadError, SectionTitle, Skeleton } from "@/components/ui/Feedback";
import { MAX_MOMENTS_PER_DAY } from "@/lib/constants";
import { diffDays, startOfYear } from "@/lib/dates";
import { fmtDayMonthShort, fmtWeekdayDate } from "@/lib/format";
import type { MomentDto } from "@/lib/types";

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-[84px] rounded-[28px]" />
        <Skeleton className="h-[84px] rounded-[28px]" />
      </div>
      <Skeleton className="h-[88px] rounded-full" />
      <Skeleton className="h-[190px] rounded-[28px]" />
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="aspect-[4/5] rounded-[22px]" />
        <Skeleton className="aspect-[4/5] rounded-[22px]" />
        <Skeleton className="aspect-[4/5] rounded-[22px]" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const t = useT();
  const h = t.home;
  const router = useRouter();
  const { locale } = useLocale();
  const today = useToday();
  const { data: me } = useMe();
  const { data, error, mutate } = useHome();
  const [viewing, setViewing] = useState<MomentDto | null>(null);
  const [hour, setHour] = useState(12);

  useEffect(() => setHour(new Date().getHours()), [today]);

  const greeting = hour < 5 ? h.greeting.night : hour < 12 ? h.greeting.morning : hour < 18 ? h.greeting.day : h.greeting.evening;
  const dayOfYear = diffDays(today, startOfYear(today));
  const headline = h.headlines[dayOfYear % h.headlines.length];
  const phrase = h.phrases[(dayOfYear * 7 + 3) % h.phrases.length];

  const limit = data?.today.limit ?? MAX_MOMENTS_PER_DAY;
  const count = data?.today.count ?? 0;
  const durationMs = data?.today.durationMs ?? 0;

  const film = data?.rendering[0] ?? data?.latestFilm ?? null;
  const recent = (data?.recent ?? []).filter((m) => m.date !== today).slice(0, 10);
  const name = me?.user.name.split(" ")[0] ?? "";

  return (
    <Page>
      <BrandHeader
        actions={
          <>
            <IconButton label={h.notifications} onClick={() => router.push("/settings#notifications")}>
              <Bell aria-hidden="true" size={21} strokeWidth={1.9} />
            </IconButton>
            <Link
              href="/settings"
              aria-label={h.profile}
              className="press grid size-[46px] place-items-center rounded-full bg-gradient-to-br from-lime-soft to-lime text-[18px] font-bold text-leaf-deep shadow-glass ring-2 ring-white/80"
            >
              <span aria-hidden="true">{(name[0] ?? "F").toLocaleUpperCase()}</span>
            </Link>
          </>
        }
      />

      <Reveal className="pb-5 pt-2">
        <p className="text-[15px] text-muted-strong">{fmtWeekdayDate(today, locale)}</p>
        <p className="mt-3 text-[15px] font-medium text-leaf-deep">{name ? h.greet(greeting, name) : greeting}</p>
        <h1 className="t-display mt-1">{headline}</h1>
        <p className="mt-2.5 text-[16px] leading-snug text-muted-strong">{phrase}</p>
      </Reveal>

      <div className="flex flex-col gap-5">
        <Onboarding />

        {!data && !error && <HomeSkeleton />}
        {!data && error && <LoadError message={errorText(t, error)} onRetry={() => void mutate()} />}

        {data && (
          <>
            <Reveal delay={1}>
              <TodayStats count={count} limit={limit} durationMs={durationMs} />
            </Reveal>

            <Reveal delay={2}>
              <RecordButton count={count} limit={limit} />
            </Reveal>

            <Reveal delay={3}>
              <ProjectsCarousel projects={data.projects} />
            </Reveal>

            <Reveal delay={4}>
              <SectionTitle
                action={
                  <Link href="/calendar" aria-label={h.openCalendar} className="glass press grid size-9 place-items-center rounded-full text-ink">
                    <ChevronRight aria-hidden="true" size={18} strokeWidth={2.2} />
                  </Link>
                }
              >
                {h.todayMoments}
              </SectionTitle>
              <TodaySlots moments={data.today.moments} limit={limit} onOpen={setViewing} />
            </Reveal>

            {film && (
              <Reveal delay={5}>
                <FilmHero film={film} today={today} />
              </Reveal>
            )}

            <Reveal delay={6}>
              <SectionTitle>{h.activity}</SectionTitle>
              <ActivityCard streak={data.streak} activity={data.activity} today={today} />
            </Reveal>

            {data.onThisDay.length > 0 && (
              <Reveal delay={7}>
                <OnThisDay groups={data.onThisDay} today={today} onOpen={setViewing} />
              </Reveal>
            )}

            {recent.length > 0 && (
              <Reveal delay={8}>
                <SectionTitle>{h.recent}</SectionTitle>
                <div className="no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5 pb-1">
                  {recent.map((m) => (
                    <MomentThumb key={m.id} moment={m} caption={fmtDayMonthShort(m.date, locale)} onClick={() => setViewing(m)} className="w-[124px] shrink-0" />
                  ))}
                </div>
              </Reveal>
            )}

            {data.totals.moments > 0 && (
              <p className="pt-1 text-center text-[13px] text-muted-strong">{h.totals(data.totals.moments, data.totals.days)}</p>
            )}
          </>
        )}
      </div>

      <MomentViewer moment={viewing} onClose={() => setViewing(null)} />
    </Page>
  );
}
