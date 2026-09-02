import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LocaleSelect } from "@/components/i18n/LocaleSelect";
import { createTranslator } from "@/lib/i18n/catalog";
import { getMessages } from "@/lib/i18n/messages";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { getOwnerActor, isOwnerRuntimeConfigured } from "@/lib/owner-auth";
import { safeOwnerReturnPath } from "@/lib/owner-auth-policy.mjs";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveRequestLocale();
  const t = createTranslator(getMessages(locale));
  return {
    title: t("login.metadataTitle"),
    robots: { index: false, follow: false },
  };
}

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const locale = await resolveRequestLocale();
  const t = createTranslator(getMessages(locale));
  const params = await searchParams;
  const returnTo = safeOwnerReturnPath(firstValue(params.return_to) || "/");
  const owner = await getOwnerActor();
  if (owner) redirect(returnTo);

  const configured = isOwnerRuntimeConfigured();
  const invalid = firstValue(params.error) === "invalid";

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          OF
        </div>
        <p className="login-eyebrow">{t("login.eyebrow")}</p>
        <h1 id="login-title">Open Fitness</h1>
        <p className="login-copy">{t("login.copy")}</p>

        {invalid ? (
          <p className="login-message login-message-error" role="alert">
            {t("login.invalid")}
          </p>
        ) : null}
        {!configured ? (
          <p className="login-message" role="status">
            {t("login.unconfigured")}
          </p>
        ) : null}

        <form className="login-form" action="/auth/login" method="post">
          <input type="hidden" name="return_to" value={returnTo} />
          <label htmlFor="owner-password">{t("login.password")}</label>
          <input
            id="owner-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            disabled={!configured}
          />
          <button type="submit" disabled={!configured}>
            {t("login.submit")}
          </button>
        </form>
        <LocaleSelect
          className="login-locale"
          locale={locale}
          label={t("language.label")}
        />
        <p className="login-footnote">{t("login.footnote")}</p>
      </section>
    </main>
  );
}
