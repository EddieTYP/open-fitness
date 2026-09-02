import type { AppLocale } from "./locales.ts";

const intlLocales: Record<AppLocale, string> = {
  en: "en",
  "zh-HK": "zh-HK",
  "zh-TW": "zh-TW",
  "zh-CN": "zh-CN",
};

export function intlLocale(locale: AppLocale) {
  return intlLocales[locale];
}

export function formatNumber(
  value: number,
  locale: AppLocale,
  options?: Intl.NumberFormatOptions,
) {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function formatDate(
  value: string | Date,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions & { timeZone?: string } = {},
) {
  const dateOnly =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date =
    value instanceof Date
      ? value
      : new Date(dateOnly ? `${value}T00:00:00Z` : value);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...(dateOnly ? { timeZone: "UTC" } : {}),
    ...options,
  }).format(date);
}

export function formatTime(
  value: string | Date,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions & { timeZone?: string } = {},
) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  }).format(date);
}
