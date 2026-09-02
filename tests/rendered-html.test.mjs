import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders production metadata with the resolved request locale", async () => {
  const layout = await readFile(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(layout, /codex-preview|development/i);
  assert.match(layout, /resolveRequestLocale\(\)/);
  assert.match(layout, /<html\s+lang=\{locale\}>/i);
  assert.doesNotMatch(layout, /<html\s+lang=["']zh-HK["']/i);
});
