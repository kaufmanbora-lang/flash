"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { deviceYmd, type Ymd } from "@/lib/dates";
import type { HomeDto, MeDto } from "@/lib/types";
import { fetcher } from "./api";
import type { DraftInfo } from "./idb";
import { uploader } from "./uploader";

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

export function useOnline(): boolean {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener("online", fn);
      window.addEventListener("offline", fn);
      return () => {
        window.removeEventListener("online", fn);
        window.removeEventListener("offline", fn);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function useMe(config?: SWRConfiguration<MeDto>) {
  return useSWR<MeDto>("/api/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 15_000, ...config });
}

export function homeKey(today: Ymd): string {
  return `/api/home?today=${today}`;
}

export function useHome() {
  const today = useToday();
  return useSWR<HomeDto>(homeKey(today), fetcher, {
    // Пока что-то обрабатывается или монтируется — опрашиваем чаще.
    refreshInterval: (data) => {
      if (!data) return 0;
      const busy =
        data.rendering.length > 0 ||
        data.today.moments.some((m) => m.status === "processing") ||
        data.recent.some((m) => m.status === "processing");
      return busy ? 3000 : 0;
    },
  });
}

/** Моменты, которые ещё лежат на устройстве и ждут загрузки. */
export function useDrafts(): DraftInfo[] {
  return useSyncExternalStore(uploader.subscribe, uploader.getSnapshot, uploader.getServerSnapshot);
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
