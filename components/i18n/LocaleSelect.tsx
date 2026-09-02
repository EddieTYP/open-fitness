"use client";

import {
  APP_LOCALES,
  APP_LOCALE_COOKIE,
  APP_LOCALE_LABELS,
  isAppLocale,
  type AppLocale,
} from "@/lib/i18n/locales";

export function persistDeviceLocale(locale: AppLocale) {
  document.cookie = `${APP_LOCALE_COOKIE}=${encodeURIComponent(locale)}; Max-Age=31536000; Path=/; SameSite=Lax`;
  document.documentElement.lang = locale;
}

export function LocaleSelect({
  locale,
  label,
  className,
}: {
  locale: AppLocale;
  label: string;
  className?: string;
}) {
  return (
    <label className={className}>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={locale}
        onChange={(event) => {
          const nextLocale = event.target.value;
          if (!isAppLocale(nextLocale) || nextLocale === locale) return;
          persistDeviceLocale(nextLocale);
          window.location.reload();
        }}
      >
        {APP_LOCALES.map((option) => (
          <option key={option} value={option}>
            {APP_LOCALE_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
