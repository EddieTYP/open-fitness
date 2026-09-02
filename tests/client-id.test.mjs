import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("client writes keep working on insecure LAN origins", async () => {
  const files = [
    "components/NutritionView.tsx",
    "components/TrainingScheduleControls.tsx",
    "components/log/LogForms.tsx",
    "components/nutrition/NutritionPlans.tsx",
    "components/nutrition/NutritionQuickRecord.tsx",
    "components/profile/ProfileSettingsDialog.tsx",
  ];
  const sources = await Promise.all(files.map(source));
  const helper = await source("lib/client-id.ts");

  assert.match(helper, /typeof cryptoApi\?\.randomUUID === "function"/);
  assert.match(helper, /cryptoApi\.getRandomValues\(bytes\)/);
  for (const component of sources) {
    assert.match(component, /clientUuid/);
    assert.doesNotMatch(component, /crypto\.randomUUID\(/);
  }
});
