import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { appleHealthActiveEnergyObservation } from "../lib/apple-health-sync.ts";

test("Apple Health settlement is narrow, historical, and content-idempotent", async () => {
  const first = await appleHealthActiveEnergyObservation(
    { localDate: "2026-08-05", activeEnergyKcal: 640 },
    "2026-08-06",
  );
  const replay = await appleHealthActiveEnergyObservation(
    { activeEnergyKcal: 640, localDate: "2026-08-05" },
    "2026-08-06",
  );
  const correction = await appleHealthActiveEnergyObservation(
    { localDate: "2026-08-05", activeEnergyKcal: 645 },
    "2026-08-06",
  );

  assert.equal(first.id, replay.id);
  assert.equal(first.requestId, replay.requestId);
  assert.notEqual(first.id, correction.id);
  assert.equal(first.mode, "settlement");
  assert.equal(first.status, "final");
  assert.equal(first.observedAt, null);
  const explicit = await appleHealthActiveEnergyObservation(
    {
      mode: "settlement",
      localDate: "2026-08-05",
      activeEnergyKcal: 640,
    },
    "2026-08-06",
  );
  assert.equal(explicit.id, first.id);
  assert.equal(explicit.requestId, first.requestId);
  await assert.rejects(
    appleHealthActiveEnergyObservation(
      { localDate: "2026-08-05", activeEnergyKcal: 640, source: "forged" },
      "2026-08-06",
    ),
    /Invalid Apple Health sync payload/,
  );
  await assert.rejects(
    appleHealthActiveEnergyObservation(
      { localDate: "2026-08-06", activeEnergyKcal: 640 },
      "2026-08-06",
    ),
    /Invalid Apple Health sync date/,
  );

  const apiRoot = new URL("../app/api/", import.meta.url);
  const tokenUsers = readdirSync(apiRoot, { recursive: true })
    .filter((path) => String(path).endsWith(".ts"))
    .filter((path) =>
      readFileSync(new URL(String(path), apiRoot), "utf8").includes(
        "FITNESS_HEALTH_SYNC_TOKEN",
      ),
    );
  assert.deepEqual(tokenUsers, ["nutrition/energy/route.ts"]);

  const energyRoute = readFileSync(
    new URL("../app/api/nutrition/energy/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    energyRoute,
    /if \(healthSyncActor\) return await syncAppleHealthEnergy\(payload, today\);/,
  );
  assert.match(energyRoute, /dateInTimeZone\(new Date\(\), timezone\)/);
  assert.match(
    energyRoute,
    /mode === "intraday"[\s\S]*observationWrite\.onConflictDoUpdate/,
  );
  assert.match(
    energyRoute,
    /operation: mode === "intraday" \? "upsert" : "insert"/,
  );
  assert.match(
    energyRoute,
    /payloadSha256: mode === "intraday" \? null : digest/,
  );

  const root = mkdtempSync(join(tmpdir(), "edward-fitness-health-token-"));
  const runtimeEnv = join(root, "runtime.env");
  try {
    writeFileSync(runtimeEnv, "FITNESS_API_TOKEN='agent-token'\n", { mode: 0o600 });
    chmodSync(runtimeEnv, 0o600);
    const install = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/install-health-sync-token.mjs", import.meta.url),
          ),
          runtimeEnv,
        ],
        { encoding: "utf8" },
      );
    const firstInstall = install();
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    assert.equal(firstInstall.stdout, '{"updated":true}\n');
    const installed = readFileSync(runtimeEnv, "utf8");
    assert.match(installed, /FITNESS_HEALTH_SYNC_TOKEN='[A-Za-z0-9_-]{43}'/);
    assert.equal(statSync(runtimeEnv).mode & 0o777, 0o600);
    const replayInstall = install();
    assert.equal(replayInstall.status, 0, replayInstall.stderr);
    assert.equal(replayInstall.stdout, '{"updated":false}\n');
    assert.equal(readFileSync(runtimeEnv, "utf8"), installed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Apple Health intraday sync accepts only today and stays provisional", async () => {
  const first = await appleHealthActiveEnergyObservation(
    {
      mode: "intraday",
      localDate: "2026-08-06",
      activeEnergyKcal: 368.3,
    },
    "2026-08-06",
    "2026-08-06T15:30:00+08:00",
  );
  const replay = await appleHealthActiveEnergyObservation(
    {
      activeEnergyKcal: 368.3,
      localDate: "2026-08-06",
      mode: "intraday",
    },
    "2026-08-06",
    "2026-08-06T15:45:00+08:00",
  );
  const laterTotal = await appleHealthActiveEnergyObservation(
    {
      mode: "intraday",
      localDate: "2026-08-06",
      activeEnergyKcal: 410,
    },
    "2026-08-06",
    "2026-08-06T16:00:00+08:00",
  );

  assert.equal(first.mode, "intraday");
  assert.equal(first.status, "provisional");
  assert.equal(first.observedAt, "2026-08-06T15:30:00+08:00");
  assert.equal(first.id, replay.id);
  assert.equal(first.id, laterTotal.id);
  assert.equal(first.requestId, laterTotal.requestId);
  assert.equal(first.id, "ENERGY|APPLE_HEALTH|INTRADAY|2026-08-06");
  assert.equal(first.requestId, "apple-health-intraday-2026-08-06");
  await assert.rejects(
    appleHealthActiveEnergyObservation(
      {
        mode: "intraday",
        localDate: "2026-08-05",
        activeEnergyKcal: 640,
      },
      "2026-08-06",
    ),
    /Invalid Apple Health sync date/,
  );
  await assert.rejects(
    appleHealthActiveEnergyObservation(
      {
        mode: "continuous",
        localDate: "2026-08-06",
        activeEnergyKcal: 640,
      },
      "2026-08-06",
    ),
    /Invalid Apple Health sync mode/,
  );
});
