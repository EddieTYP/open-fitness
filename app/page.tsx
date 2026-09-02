import { Suspense } from "react";
import { FitnessApp } from "@/components/FitnessApp";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { getDashboardData } from "@/lib/fitness";
import { createTranslator } from "@/lib/i18n/catalog";
import { getMessages } from "@/lib/i18n/messages";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { requireOwner } from "@/lib/owner-auth";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

function AppSkeleton({ label }: { label: string }) {
  return (
    <div className="app-shell" aria-busy="true" aria-label={label}>
      <header className="app-header">
        <div className="skeleton skeleton-brand" />
        <div className="skeleton skeleton-sync" />
      </header>
      <main className="app-main">
        <div className="today-view">
          <div className="skeleton skeleton-briefing" />
          <div className="skeleton skeleton-course" />
        </div>
      </main>
    </div>
  );
}

type InitialTab = "today" | "log" | "nutrition" | "progress";

function isIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

async function AuthenticatedFitnessApp({
  initialTab,
  requestedNutritionDate,
}: {
  initialTab: InitialTab;
  requestedNutritionDate?: string;
}) {
  const data = await getDashboardData();
  const locale = await resolveRequestLocale(
    data.profile?.setupCompleted ? data.profile.preferredLocale : undefined,
  );
  const messages = getMessages(locale);
  const t = createTranslator(messages);
  const requestedAt = new Date().toISOString();
  const displayName =
    data.profile?.displayName?.trim() ||
    process.env.FITNESS_OWNER_DISPLAY_NAME?.trim() ||
    t("common.owner");
  const today = dateInTimeZone(new Date(), data.profile?.timezone);
  const initialNutritionDate =
    requestedNutritionDate && isIsoDate(requestedNutritionDate)
      ? requestedNutritionDate > today
        ? today
        : requestedNutritionDate
      : undefined;

  return (
    <I18nProvider locale={locale} messages={messages}>
      <FitnessApp
        data={data}
        displayName={displayName}
        requestedAt={requestedAt}
        initialTab={initialTab}
        initialNutritionDate={initialNutritionDate}
      />
    </I18nProvider>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  await requireOwner("/");
  const requestLocale = await resolveRequestLocale();
  const t = createTranslator(getMessages(requestLocale));
  const params = await searchParams;
  const tabValue = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const initialTab: InitialTab =
    tabValue === "log" ||
    tabValue === "nutrition" ||
    tabValue === "progress"
      ? tabValue
      : "today";
  const dateValue = Array.isArray(params.date)
    ? params.date[0]
    : params.date;
  return (
    <Suspense fallback={<AppSkeleton label={t("app.loading")} />}>
      <AuthenticatedFitnessApp
        initialTab={initialTab}
        requestedNutritionDate={dateValue}
      />
    </Suspense>
  );
}
