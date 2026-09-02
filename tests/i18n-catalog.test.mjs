import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTranslator,
  messagesForLocale,
} from "../lib/i18n/catalog.ts";
import { formatDate, formatNumber } from "../lib/i18n/format.ts";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("every locale exposes the same common message keys", () => {
  const expected = Object.keys(getMessages("en")).sort();
  for (const locale of APP_LOCALES) {
    assert.deepEqual(Object.keys(getMessages(locale)).sort(), expected);
  }
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(pathname);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [pathname] : [];
    }),
  );
  return files.flat();
}

test("every static UI translation key exists in the catalog", async () => {
  const catalog = getMessages("en");
  const files = (
    await Promise.all(
      ["app", "components"].map((directory) =>
        sourceFiles(path.join(root, directory)),
      ),
    )
  ).flat();
  const missing = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
      if (!Object.hasOwn(catalog, match[1])) {
        missing.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("catalog assembly rejects duplicate keys instead of silently overriding", () => {
  const duplicate = {
    en: { duplicate: "one" },
    "zh-HK": { duplicate: "一" },
    "zh-TW": { duplicate: "一" },
    "zh-CN": { duplicate: "一" },
  };
  assert.throws(
    () => messagesForLocale("en", duplicate, duplicate),
    /Duplicate i18n message key: duplicate/,
  );
});

test("translator interpolates named values without evaluating source text", () => {
  const t = createTranslator({ greeting: "Hello {{ name }}, {{count}} items" });
  assert.equal(t("greeting", { name: "Alex", count: 2 }), "Hello Alex, 2 items");
  assert.equal(t("missing.key"), "missing.key");
});

test("formatters use locale without coupling it to timezone", () => {
  assert.equal(formatNumber(1234.5, "en", { maximumFractionDigits: 1 }), "1,234.5");
  assert.match(
    formatDate("2026-08-09", "zh-CN", { year: "numeric", month: "long", day: "numeric" }),
    /2026.*8.*9/,
  );
  assert.notEqual(
    formatDate("2026-08-09T01:00:00Z", "en", {
      timeZone: "Asia/Hong_Kong",
      day: "numeric",
    }),
    formatDate("2026-08-09T01:00:00Z", "en", {
      timeZone: "America/Los_Angeles",
      day: "numeric",
    }),
  );
});
