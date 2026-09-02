import type { MetadataRoute } from "next";
import { createTranslator } from "@/lib/i18n/catalog";
import { getMessages } from "@/lib/i18n/messages";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const locale = await resolveRequestLocale();
  const t = createTranslator(getMessages(locale));
  return {
    name: "Open Fitness",
    short_name: "Fitness",
    description: t("metadata.description"),
    lang: locale,
    start_url: "/",
    display: "standalone",
    background_color: "#f2f5f4",
    theme_color: "#23695a",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
