import { cookies, headers } from "next/headers";

import {
  APP_LOCALE_COOKIE,
  resolveAppLocale,
  type AppLocale,
} from "./locales.ts";

export async function resolveRequestLocale(
  profileLocale?: unknown,
): Promise<AppLocale> {
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ]);

  return resolveAppLocale({
    cookieLocale: cookieStore.get(APP_LOCALE_COOKIE)?.value,
    profileLocale,
    acceptLanguage: requestHeaders.get("accept-language"),
  });
}
