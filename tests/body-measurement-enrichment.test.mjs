import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("body measurement API exposes exact read and fill-only enrichment", () => {
  const route = source("app/api/fitness/body-measurements/route.ts");
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /measurementId is required/);
  assert.match(route, /export async function PATCH\(request: Request\)/);
  assert.match(route, /expectedCreatedAt/);
  assert.match(route, /currentValue === null/);
  assert.match(route, /field === "sourceDevice" && currentValue === "Manual entry"/);
  assert.match(
    route,
    /field === "sourceFile" && currentValue === "Open Fitness WebApp"/,
  );
  assert.match(route, /rawValues\.source\?\.trim\(\)/);
  assert.match(route, /BODY_MEASUREMENT_FIELD_CONFLICT/);
  assert.match(route, /operation: "enrich"/);
  assert.match(route, /source\?: string/);
  assert.match(route, /payload\.source\?\.trim\(\)/);
  assert.match(route, /payload\.sourceFile\?\.trim\(\)/);
  assert.match(route, /return \{ \.\.\.values, source: sourceFile \}/);

  const analysis = source("app/api/fitness/analysis/route.ts");
  assert.match(analysis, /source: sourceFile/);
});

test("Fitness MCP exposes exact measurement read and safe enrichment only", () => {
  const mcp = source("agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs");
  const contract = source("agent-plugin/skills/open-fitness/references/contract.md");
  assert.match(mcp, /body_measurement:\s*\{/);
  assert.match(mcp, /required: \["measurementId"\]/);
  assert.match(
    mcp,
    /body_measurement_enrich:\s*writeDescriptor\(\s*"PATCH",\s*"\/api\/fitness\/body-measurements"/,
  );
  assert.match(
    mcp,
    /verifyBodyMeasurementEnrich[\s\S]*Object\.entries\(body\.values\)/,
  );
  assert.match(contract, /mutation passed connector-owned verification/);
  assert.match(contract, /cannot overwrite other non-null values/);
  assert.match(mcp, /source: "Data channel"/);
  assert.match(mcp, /sourceDevice: "Measuring device"/);
  assert.match(mcp, /body_measurement_create:[\s\S]*sourceFile/);
});
