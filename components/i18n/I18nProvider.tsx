"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  createTranslator,
  type MessageCatalog,
  type MessageValues,
} from "@/lib/i18n/catalog";
import {
  formatDate,
  formatNumber,
  formatTime,
} from "@/lib/i18n/format";
import type { AppLocale } from "@/lib/i18n/locales";

type I18nContextValue = {
  locale: AppLocale;
  t: (key: string, values?: MessageValues) => string;
  formatDate: (
    value: string | Date,
    options?: Intl.DateTimeFormatOptions & { timeZone?: string },
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatTime: (
    value: string | Date,
    options?: Intl.DateTimeFormatOptions & { timeZone?: string },
  ) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: AppLocale;
  messages: MessageCatalog;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const translate = createTranslator(messages);
    return {
      locale,
      t: translate,
      formatDate: (input, options) => formatDate(input, locale, options),
      formatNumber: (input, options) => formatNumber(input, locale, options),
      formatTime: (input, options) => formatTime(input, locale, options),
    };
  }, [locale, messages]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
