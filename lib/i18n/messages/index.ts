import type { AppLocale } from "../locales.ts";
import { messagesForLocale } from "../catalog.ts";
import { commonMessages } from "./common.ts";
import { exerciseMessages } from "./exercises.ts";
import { fitnessMessages } from "./fitness.ts";
import { logMessages } from "./log.ts";
import { nutritionMessages } from "./nutrition.ts";
import { profileMessages } from "./profile.ts";

export function getMessages(locale: AppLocale) {
  return messagesForLocale(
    locale,
    commonMessages,
    exerciseMessages,
    fitnessMessages,
    logMessages,
    nutritionMessages,
    profileMessages,
  );
}
