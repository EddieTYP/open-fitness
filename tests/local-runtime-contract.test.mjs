import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function json(path) {
  return JSON.parse(source(path));
}

const NATIVE_TYPESCRIPT_BLOCKERS = [
  "app/api/fitness/workout-sessions/route.ts",
  "app/api/nutrition/meals/route.ts",
  "app/api/nutrition/plans/route.ts",
  "components/nutrition/NutritionPlans.tsx",
];

test("canonical scripts use native Next and bind listeners to loopback", () => {
  const { scripts } = json("package.json");
  const actual = Object.fromEntries(
    ["dev", "build", "start"].map((name) => [
      name,
      scripts?.[name],
    ]),
  );

  assert.deepEqual(actual, {
    dev: "next dev --hostname 127.0.0.1",
    build: "next build --webpack",
    start: "node --env-file-if-exists=.env.local scripts/start-self-host.mjs",
  });
  const selfHostStart = source("scripts/start-self-host.mjs");
  assert.match(selfHostStart, /HOSTNAME: "127\.0\.0\.1"/);
  assert.match(
    selfHostStart,
    /ownerPasswordHash\?\.startsWith\("scrypt\\\\\$"\)/,
  );
  assert.match(selfHostStart, /ownerPasswordHash\.replaceAll\([\s\S]*?"\\\\\$",[\s\S]*?"\$"/);
  assert.match(selfHostStart, /\.next", "standalone"/);
  assert.match(selfHostStart, /standaloneRoot, "server\.js"/);
  assert.match(selfHostStart, /cpSync\(publicSource/);
  assert.match(selfHostStart, /cpSync\(staticSource/);
  assert.match(source("next.config.ts"), /output:\s*"standalone"/);
  assert.match(
    source("next.config.ts"),
    /process\.env\.FITNESS_DEV_ALLOWED_ORIGINS/,
  );
  assert.doesNotMatch(source("next.config.ts"), /192\.168\.1\.104/);
  assert.match(
    source("next.config.ts"),
    /node_modules\/@libsql\/darwin-\*\/\*\*\/\*/,
  );
});

test("the local libSQL client is a pinned production dependency", () => {
  const manifest = json("package.json");
  const lock = json("package-lock.json");
  const expectedVersion = "0.17.4";

  assert.equal(manifest.dependencies?.["@libsql/client"], expectedVersion);
  assert.equal(
    manifest.overrides?.["@libsql/isomorphic-ws"]?.ws,
    "8.21.2",
  );
  assert.equal(lock.packages?.[""]?.dependencies?.["@libsql/client"], expectedVersion);
  assert.equal(
    lock.packages?.["node_modules/@libsql/client"]?.version,
    expectedVersion,
  );
  assert.equal(
    lock.packages?.["node_modules/@libsql/isomorphic-ws/node_modules/ws"]
      ?.version,
    "8.21.2",
  );
  assert.notEqual(
    lock.packages?.["node_modules/@libsql/isomorphic-ws/node_modules/ws"]?.dev,
    true,
  );
  assert.equal(lock.packages?.["node_modules/ws"], undefined);
});

test("the native Next runtime is pinned to the audited security update", () => {
  const manifest = json("package.json");
  const lock = json("package-lock.json");

  assert.equal(manifest.dependencies?.next, "16.3.0");
  assert.equal(manifest.devDependencies?.["eslint-config-next"], "16.3.0");
  assert.equal(lock.packages?.[""]?.dependencies?.next, "16.3.0");
  assert.equal(lock.packages?.["node_modules/next"]?.version, "16.3.0");
  assert.equal(
    lock.packages?.["node_modules/eslint-config-next"]?.version,
    "16.3.0",
  );
});

test("the local runtime has no online admin import route", () => {
  assert.equal(
    existsSync(new URL("../app/api/fitness/admin/import/route.ts", import.meta.url)),
    false,
  );
});

test("native automation auth is fail-closed and preview access is explicit", async () => {
  const policyUrl = new URL("../lib/api-auth-policy.ts", import.meta.url);
  const runtimeEnvUrl = new URL("../lib/runtime-env.ts", import.meta.url);
  assert.ok(
    existsSync(policyUrl),
    "Missing lib/api-auth-policy.ts: add a pure native automation-auth policy before this contract can pass",
  );
  const policy = await import(`${policyUrl.href}?contract=runtime`);
  const runtimeEnv = await import(`${runtimeEnvUrl.href}?contract=runtime`);
  const contractEnvName = "FITNESS_CONTRACT_RUNTIME_ENV";
  const previousContractEnv = process.env[contractEnvName];
  try {
    process.env[contractEnvName] = "   ";
    assert.equal(runtimeEnv.getRuntimeEnvValue(contractEnvName), null);
    process.env[contractEnvName] = "  normalized-value  ";
    assert.equal(
      runtimeEnv.getRuntimeEnvValue(contractEnvName),
      "normalized-value",
    );
  } finally {
    if (previousContractEnv === undefined) delete process.env[contractEnvName];
    else process.env[contractEnvName] = previousContractEnv;
  }
  assert.equal(typeof policy.resolveAutomationActor, "function");
  const request = (authorization) =>
    new Request("http://127.0.0.1/api/fitness/dashboard", {
      headers: authorization ? { authorization } : undefined,
    });
  const production = {
    apiToken: "contract-agent-token",
    nodeEnv: "production",
    allowLocalPreview: true,
  };

  assert.equal(await policy.resolveAutomationActor(request(), production), null);
  assert.equal(
    await policy.resolveAutomationActor(request("Bearer wrong-token"), production),
    null,
  );
  assert.deepEqual(
    await policy.resolveAutomationActor(
      request("Bearer contract-agent-token"),
      production,
    ),
    { id: "open-fitness-agent", kind: "fitness-agent" },
  );
  assert.deepEqual(
    await policy.resolveAutomationActor(request("Bearer contract-agent-token"), {
      ...production,
      apiToken: "  contract-agent-token  ",
    }),
    { id: "open-fitness-agent", kind: "fitness-agent" },
  );
  assert.equal(
    await policy.resolveAutomationActor(request(), {
      apiToken: undefined,
      nodeEnv: "development",
      allowLocalPreview: false,
    }),
    null,
  );
  assert.equal(
    await policy.resolveAutomationActor(request("Bearer wrong-token"), {
      apiToken: "contract-agent-token",
      nodeEnv: "development",
      allowLocalPreview: true,
    }),
    null,
  );
  assert.equal(
    await policy.resolveAutomationActor(request("Basic Y29udHJhY3Q="), {
      apiToken: "contract-agent-token",
      nodeEnv: "development",
      allowLocalPreview: true,
    }),
    null,
  );
  for (const nodeEnv of [undefined, "prod"]) {
    assert.equal(
      await policy.resolveAutomationActor(request(), {
        apiToken: undefined,
        nodeEnv,
        allowLocalPreview: true,
      }),
      null,
    );
  }
  assert.deepEqual(
    await policy.resolveAutomationActor(request(), {
      apiToken: undefined,
      nodeEnv: "development",
      allowLocalPreview: true,
    }),
    { id: "local-preview", kind: "local-preview" },
  );
});

test("the native port retains idempotency, revision, audit, void, and read-back contracts", () => {
  const idempotency = source("lib/idempotency.ts");
  const workoutRoute = source("app/api/fitness/workout-sessions/route.ts");
  const mealRoute = source("app/api/nutrition/meals/route.ts");

  assert.match(idempotency, /existing\.payloadSha256\s*!==\s*payloadSha256/);
  assert.match(idempotency, /Idempotency key conflict/);
  assert.match(workoutRoute, /findIdempotentReplay/);
  assert.match(workoutRoute, /replay:\s*true/);
  assert.match(workoutRoute, /tx\.insert\(auditLog\)/);
  assert.match(workoutRoute, /action\s*!==\s*"void"\s*&&\s*action\s*!==\s*"restore"/);
  assert.match(mealRoute, /expectedRevisionNo/);
  assert.match(mealRoute, /nutritionMealRevisions/);
  assert.match(mealRoute, /tx\.insert\(auditLog\)/);
  assert.match(mealRoute, /voidedAt/);
  assert.match(mealRoute, /await db\.transaction/);

  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "tests/workout-write-contract.test.mjs",
      "tests/dashboard-contract.test.mjs",
      "tests/nutrition-state.test.mjs",
    ],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  assert.equal(result.status, 0, output);
  // sqlite-runtime.test.mjs performs the independent post-close read-back.
});

test("the complete native TypeScript graph covers every baseline blocker file", () => {
  for (const path of NATIVE_TYPESCRIPT_BLOCKERS) {
    assert.ok(source(path).length > 0, `Missing native blocker contract target: ${path}`);
  }

  const tsc = fileURLToPath(
    new URL("node_modules/typescript/bin/tsc", root),
  );
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--incremental",
      "false",
      "--pretty",
      "false",
      "--listFiles",
    ],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  assert.equal(
    result.status,
    0,
    `Native TypeScript contract failed. The baseline blocker files are:\n${NATIVE_TYPESCRIPT_BLOCKERS.join("\n")}\n\n${output}`,
  );
  const compiledFiles = new Set(
    (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const path of NATIVE_TYPESCRIPT_BLOCKERS) {
    const expectedPath = fileURLToPath(new URL(path, root));
    assert.ok(
      compiledFiles.has(expectedPath),
      `Native TypeScript graph omitted baseline blocker: ${path}`,
    );
  }
});
