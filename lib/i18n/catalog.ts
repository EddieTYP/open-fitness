import type { AppLocale } from "./locales.ts";

export type MessageValues = Record<string, string | number>;
export type MessageCatalog = Record<string, string>;
export type MessageSet = Record<AppLocale, MessageCatalog>;

export function defineMessageSet<const English extends MessageCatalog>(
  messages: {
    en: English;
    "zh-HK": { [Key in keyof English]: string };
    "zh-TW": { [Key in keyof English]: string };
    "zh-CN": { [Key in keyof English]: string };
  },
) {
  return messages;
}

export function messagesForLocale(
  locale: AppLocale,
  ...sets: readonly MessageSet[]
): MessageCatalog {
  const catalog: MessageCatalog = {};

  for (const set of sets) {
    for (const [key, value] of Object.entries(set[locale])) {
      if (Object.hasOwn(catalog, key)) {
        throw new Error(`Duplicate i18n message key: ${key}`);
      }
      catalog[key] = value;
    }
  }

  return catalog;
}

export function createTranslator(messages: MessageCatalog) {
  return (key: string, values: MessageValues = {}) => {
    const template = messages[key] ?? key;
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  };
}

export type Translator = ReturnType<typeof createTranslator>;
