export const APP_LOCALES = ["en", "zh-HK", "zh-TW", "zh-CN"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = "en";
export const FRESH_INSTALL_DEFAULT_APP_LOCALE: AppLocale = DEFAULT_APP_LOCALE;
export const APP_LOCALE_COOKIE = "fitness_locale";

export const APP_LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  "zh-HK": "繁體中文（香港）",
  "zh-TW": "繁體中文（台灣）",
  "zh-CN": "简体中文（中国大陆）",
};

export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    APP_LOCALES.includes(value as AppLocale)
  );
}

export function normaliseAppLocale(value: unknown): AppLocale | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().replaceAll("_", "-").toLowerCase();
  if (!tag) return null;
  if (tag === "en" || tag.startsWith("en-")) return "en";

  if (tag === "zh-tw" || tag.startsWith("zh-tw-")) return "zh-TW";
  if (tag === "zh-cn" || tag.startsWith("zh-cn-")) return "zh-CN";
  if (tag === "zh-hk" || tag.startsWith("zh-hk-")) return "zh-HK";

  if (tag.startsWith("zh-hant-tw")) return "zh-TW";
  if (tag.startsWith("zh-hans")) return "zh-CN";
  if (tag.startsWith("zh-sg")) return "zh-CN";
  if (tag.startsWith("zh-mo") || tag.startsWith("zh-hant")) return "zh-HK";
  if (tag === "zh" || tag.startsWith("zh-")) return DEFAULT_APP_LOCALE;
  return null;
}

export function localeFromAcceptLanguage(
  header: string | null | undefined,
): AppLocale | null {
  if (!header) return null;
  return header
    .split(",")
    .map((entry, index) => {
      const [language, ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().toLowerCase().startsWith("q="),
      );
      const parsedQuality = qualityParameter
        ? Number(qualityParameter.trim().slice(2))
        : 1;
      return {
        locale: normaliseAppLocale(language),
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
        index,
      };
    })
    .filter(
      (candidate): candidate is {
        locale: AppLocale;
        quality: number;
        index: number;
      } => candidate.locale !== null && candidate.quality > 0,
    )
    .sort(
      (left, right) =>
        right.quality - left.quality || left.index - right.index,
    )[0]?.locale ?? null;
}

export function resolveAppLocale({
  cookieLocale,
  profileLocale,
  acceptLanguage,
}: {
  cookieLocale?: unknown;
  profileLocale?: unknown;
  acceptLanguage?: string | null;
}): AppLocale {
  return (
    normaliseAppLocale(cookieLocale) ??
    normaliseAppLocale(profileLocale) ??
    localeFromAcceptLanguage(acceptLanguage) ??
    DEFAULT_APP_LOCALE
  );
}
