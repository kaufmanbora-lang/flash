"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { deviceYmd, type Ymd } from "@/lib/dates";
import type { HomeDto, MeDto } from "@/lib/types";
import { fetcher } from "./api";

/** Сегодняшняя дата по часам устройства; обновляется после полуночи и при возврате в приложение. */
export function useToday(): Ymd {
  const [today, setToday] = useState<Ymd>(() => deviceYmd());
  useEffect(() => {
    const check = () => setToday((prev) => (prev === deviceYmd() ? prev : deviceYmd()));
    const timer = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

export function useMe(config?: SWRConfiguration<MeDto>) {
  return useSWR<MeDto>("/api/me", fetcher, config);
}

export function homeKey(today: Ymd): string {
  return `/api/home?today=${today}`;
}

export function useHome() {
  const today = useToday();
  return useSWR<HomeDto>(homeKey(today), fetcher);
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** true только после монтирования в браузере — для частей интерфейса, зависящих от устройства. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Параметр из адресной строки (?id=…). Страницы приложения — статические файлы, поэтому идентификатор
 * фильма или проекта передаётся параметром, а не частью пути. До монтирования возвращает undefined.
 */
export function useQueryParam(name: string): string | null | undefined {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setValue(new URLSearchParams(window.location.search).get(name));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [name]);
  return value;
}
