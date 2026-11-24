"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, getDict, isLocale, type Dict, type Locale } from "@/i18n";

interface I18nValue {
  t: Dict;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue>({
  t: getDict(DEFAULT_LOCALE),
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
});

const STORAGE_KEY = "flash-locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isLocale(saved)) setLocaleState(saved);
    } catch {
      /* хранилище недоступно — остаётся язык по умолчанию */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* не критично */
    }
  }, []);

  const value = useMemo(() => ({ t: getDict(locale), locale, setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Словарь текущего языка. */
export function useT(): Dict {
  return useContext(I18nContext).t;
}

export function useLocale(): Pick<I18nValue, "locale" | "setLocale"> {
  const { locale, setLocale } = useContext(I18nContext);
  return { locale, setLocale };
}
