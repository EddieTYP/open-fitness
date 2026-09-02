import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const NOW_MS = 1_800_000_000_000;
const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "correct horse battery staples";
const LEGACY_SHORT_PASSWORD = "short";
const LEGACY_SHORT_PASSWORD_HASH =
  "scrypt$1$16384$8$1$KSkpKSkpKSkpKSkpKSkpKQ$bi6Rc_WwtlsyQFYbsciKMoAiCmOrcLZxwtgtkA79sJM";
const SESSION_SECRET = "session-secret-with-at-least-thirty-two-bytes";
const PUBLIC_ORIGIN = "https://fitness.private.example";

function source(path) {
  return readFileSync(new URL(path, root), "utf8");
}

async function ownerPolicy() {
  return import(
    `${new URL("../lib/owner-auth-policy.mjs", import.meta.url).href}?owner-contract`
  );
}

async function apiPolicy() {
  return import(
    `${new URL("../lib/api-auth-policy.ts", import.meta.url).href}?owner-contract`
  );
}

async function loginThrottlePolicy() {
  return import(
    `${new URL("../lib/owner-login-throttle.mjs", import.meta.url).href}?owner-contract`
  );
}

function trustedProxyHeaders(clientAddress) {
  const host = new URL(PUBLIC_ORIGIN).host;
  return {
    host,
    "x-forwarded-for": clientAddress,
    "x-forwarded-host": host,
    "x-forwarded-proto": "https",
  };
}

test("owner password hashes are versioned scrypt records and verify exactly", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 7),
  });

  assert.match(passwordHash, /^scrypt\$1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(passwordHash.includes(PASSWORD), false);
  assert.equal(await policy.verifyOwnerPassword(PASSWORD, passwordHash), true);
  assert.equal(await policy.verifyOwnerPassword(OTHER_PASSWORD, passwordHash), false);
  assert.equal(await policy.verifyOwnerPassword(` ${PASSWORD}`, passwordHash), false);
  assert.equal(await policy.verifyOwnerPassword("", passwordHash), false);
  assert.equal(await policy.verifyOwnerPassword("x".repeat(1025), passwordHash), false);
  assert.equal(await policy.verifyOwnerPassword(PASSWORD, "malformed"), false);
  assert.equal(policy.isOwnerPasswordHash(passwordHash), true);
  assert.equal(policy.isOwnerPasswordHash("malformed"), false);

  await assert.rejects(
    policy.hashOwnerPassword("elevenchars"),
    /12 to 1024 Unicode characters/,
  );
  await assert.rejects(
    policy.hashOwnerPassword("😀".repeat(11)),
    /12 to 1024 Unicode characters/,
  );
  await assert.rejects(
    policy.hashOwnerPassword("😀".repeat(1_025)),
    /12 to 1024 Unicode characters/,
  );
  const unicodeHash = await policy.hashOwnerPassword("😀".repeat(12), {
    salt: Buffer.alloc(16, 8),
  });
  assert.equal(await policy.verifyOwnerPassword("😀".repeat(12), unicodeHash), true);
});

test("legacy short owner password hashes remain verifiable after upgrade", async () => {
  const policy = await ownerPolicy();
  assert.equal(
    await policy.verifyOwnerPassword(
      LEGACY_SHORT_PASSWORD,
      LEGACY_SHORT_PASSWORD_HASH,
    ),
    true,
  );
  assert.equal(
    await policy.verifyOwnerPassword("wrong", LEGACY_SHORT_PASSWORD_HASH),
    false,
  );
  await assert.rejects(
    policy.hashOwnerPassword(LEGACY_SHORT_PASSWORD, {
      salt: Buffer.alloc(16, 41),
    }),
    /12 to 1024 Unicode characters/,
  );
});

test("the password hashing script consumes stdin and emits only a verifiable hash", async () => {
  const scriptPath = new URL("../scripts/hash-owner-password.mjs", import.meta.url);
  assert.equal(existsSync(scriptPath), true);

  const result = spawnSync(process.execPath, [fileURLToPath(scriptPath)], {
    cwd: new URL("../", import.meta.url),
    input: `${PASSWORD}\n`,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const passwordHash = result.stdout.trim();
  assert.equal(passwordHash.includes(PASSWORD), false);
  assert.equal((await ownerPolicy()).isOwnerPasswordHash(passwordHash), true);
  assert.equal(
    await (await ownerPolicy()).verifyOwnerPassword(PASSWORD, passwordHash),
    true,
  );

  const weak = spawnSync(process.execPath, [fileURLToPath(scriptPath)], {
    cwd: new URL("../", import.meta.url),
    input: `${LEGACY_SHORT_PASSWORD}\n`,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.notEqual(weak.status, 0);
  assert.equal(weak.stdout, "");
  assert.match(weak.stderr, /12 to 1024 Unicode characters/);
});

test("owner login client keys trust only one sanitized proxy address", async () => {
  const policy = await loginThrottlePolicy();
  const direct = policy.ownerLoginClientKey(new Request(`${PUBLIC_ORIGIN}/auth/login`));
  const first = policy.ownerLoginClientKey(
    new Request(`${PUBLIC_ORIGIN}/auth/login`, {
      headers: trustedProxyHeaders("192.0.2.10"),
    }),
  );
  const second = policy.ownerLoginClientKey(
    new Request(`${PUBLIC_ORIGIN}/auth/login`, {
      headers: trustedProxyHeaders("192.0.2.11"),
    }),
  );
  assert.notEqual(first, direct);
  assert.notEqual(second, direct);
  assert.notEqual(first, second);
  assert.equal(first.includes("192.0.2.10"), false);
  assert.equal(
    policy.ownerLoginClientKey(
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        headers: trustedProxyHeaders("2001:0db8:0:0:0:0:0:1"),
      }),
    ),
    policy.ownerLoginClientKey(
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        headers: trustedProxyHeaders("2001:db8::1"),
      }),
    ),
  );

  for (const headers of [
    { ...trustedProxyHeaders("192.0.2.10, 192.0.2.11") },
    { ...trustedProxyHeaders("not-an-address") },
    { ...trustedProxyHeaders("192.0.2.10"), "x-forwarded-proto": "http" },
    { ...trustedProxyHeaders("192.0.2.10"), "x-forwarded-host": "evil.example" },
  ]) {
    assert.equal(
      policy.ownerLoginClientKey(
        new Request(`${PUBLIC_ORIGIN}/auth/login`, { headers }),
      ),
      direct,
    );
  }
});

test("owner login throttling follows a rolling failure window", async () => {
  const policy = await loginThrottlePolicy();
  const rolling = policy.createOwnerLoginThrottle({
    failureLimit: 2,
    windowMs: 10_000,
    maxClients: 3,
  });

  rolling.reserveFailure("client", 0);
  rolling.reserveFailure("client", 9_999);
  assert.equal(rolling.retryAfterSeconds("client", 9_999), 1);
  // The first failure expires on its own instead of resetting the newer one.
  assert.equal(rolling.retryAfterSeconds("client", 10_000), null);
  rolling.reserveFailure("client", 10_000);
  assert.equal(rolling.retryAfterSeconds("client", 10_000), 10);
  assert.equal(rolling.retryAfterSeconds("client", 19_998), 1);
  assert.equal(rolling.retryAfterSeconds("client", 19_999), null);
  assert.equal(rolling.trackedClientCount, 1);
  assert.equal(rolling.retryAfterSeconds("client", 20_000), null);
  assert.equal(rolling.trackedClientCount, 0);
});

test("owner login reservations block parallel checks and release on exceptions", async () => {
  const policy = await loginThrottlePolicy();
  const throttle = policy.createOwnerLoginThrottle({
    failureLimit: 2,
    windowMs: 10_000,
    maxClients: 3,
  });

  const releaseFirst = throttle.reserveFailure("client", 1_000);
  const releaseSecond = throttle.reserveFailure("client", 1_001);
  assert.equal(throttle.retryAfterSeconds("client", 1_001), 10);

  // The route invokes the release callback when password verification throws.
  releaseSecond();
  releaseSecond();
  assert.equal(throttle.retryAfterSeconds("client", 1_002), null);

  throttle.reserveFailure("client", 1_003);
  assert.equal(throttle.retryAfterSeconds("client", 1_003), 10);
  releaseFirst();
  assert.equal(throttle.retryAfterSeconds("client", 1_004), null);

  throttle.clear("client");
  assert.equal(throttle.retryAfterSeconds("client", 1_004), null);
});

test("owner login throttling caps state and shares an overflow bucket", async () => {
  const policy = await loginThrottlePolicy();
  const throttle = policy.createOwnerLoginThrottle();

  for (let index = 0; index < policy.OWNER_LOGIN_MAX_CLIENTS + 20; index += 1) {
    throttle.reserveFailure(`client-${index}`, 2_000);
  }
  assert.equal(throttle.trackedClientCount, policy.OWNER_LOGIN_MAX_CLIENTS);
  assert.equal(throttle.retryAfterSeconds("another-client", 2_001), 900);

  assert.equal(
    throttle.retryAfterSeconds(
      "another-client",
      2_000 + policy.OWNER_LOGIN_FAILURE_WINDOW_MS,
    ),
    null,
  );
  assert.equal(throttle.trackedClientCount, 0);
});

test("owner sessions reject expiry, tampering, rotation, and malformed cookies", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 11),
  });
  const token = policy.createOwnerSessionToken({
    passwordHash,
    sessionSecret: SESSION_SECRET,
    nowMs: NOW_MS,
  });

  assert.equal(token.includes(PASSWORD), false);
  assert.equal(token.includes(passwordHash), false);
  assert.deepEqual(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS + 1_000,
    }),
    policy.OWNER_ACTOR,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(`${token.slice(0, -1)}x`, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: `${SESSION_SECRET}-rotated`,
      nowMs: NOW_MS,
    }),
    null,
  );
  const rotatedHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 12),
  });
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash: rotatedHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS + (policy.OWNER_SESSION_TTL_SECONDS + 1) * 1_000,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS - 1_000,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS - 60_000,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS - 61_000,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken(token, {
      passwordHash,
      sessionSecret: "too-short",
      nowMs: NOW_MS,
    }),
    null,
  );
  assert.throws(() =>
    policy.createOwnerSessionToken({
      passwordHash,
      sessionSecret: "too-short",
      nowMs: NOW_MS,
    }),
  );
  assert.equal(
    policy.verifyOwnerSessionToken("x".repeat(4_097), {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS,
    }),
    null,
  );
  assert.equal(
    policy.verifyOwnerSessionToken("malformed", {
      passwordHash,
      sessionSecret: SESSION_SECRET,
      nowMs: NOW_MS,
    }),
    null,
  );

  const cookie = `${policy.OWNER_SESSION_COOKIE_NAME}=${token}`;
  assert.deepEqual(
    policy.getOwnerActorFromRequest(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { cookie },
      }),
      {
        passwordHash,
        publicOrigin: PUBLIC_ORIGIN,
        sessionSecret: SESSION_SECRET,
        nodeEnv: "production",
        nowMs: NOW_MS,
      },
    ),
    policy.OWNER_ACTOR,
  );
  assert.equal(
    policy.getOwnerActorFromRequest(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { cookie: `${cookie}; ${cookie}` },
      }),
      {
        passwordHash,
        publicOrigin: PUBLIC_ORIGIN,
        sessionSecret: SESSION_SECRET,
        nodeEnv: "production",
        nowMs: NOW_MS,
      },
    ),
    null,
  );
});

test("cookie serialization is HttpOnly, strict, path-scoped, and production-secure", async () => {
  const policy = await ownerPolicy();
  const secure = policy.serializeOwnerSessionCookie("signed.token", {
    secure: true,
  });
  assert.match(secure, new RegExp(`^${policy.OWNER_SESSION_COOKIE_NAME}=`));
  assert.match(secure, /; Path=\//);
  assert.match(secure, /; HttpOnly/);
  assert.match(secure, /; SameSite=Strict/);
  assert.match(secure, /; Secure/);
  assert.match(secure, /; Max-Age=\d+/);
  assert.doesNotMatch(secure, /Domain=/i);

  const local = policy.serializeOwnerSessionCookie("signed.token", {
    secure: false,
  });
  assert.doesNotMatch(local, /; Secure/);
  const cleared = policy.serializeClearedOwnerSessionCookie({ secure: true });
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(cleared, /; Secure/);
});

test("owner session cookies can be isolated for instances on the same hostname", () => {
  const policyUrl = new URL(
    "../lib/owner-auth-policy.mjs?isolated-cookie-contract",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const policy = await import(${JSON.stringify(policyUrl)}); process.stdout.write(JSON.stringify({ name: policy.OWNER_SESSION_COOKIE_NAME, cookie: policy.serializeOwnerSessionCookie("signed.token", { secure: false }) }));`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FITNESS_OWNER_SESSION_COOKIE_NAME: "open_fitness_isolated_session",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const isolated = JSON.parse(result.stdout);
  assert.equal(isolated.name, "open_fitness_isolated_session");
  assert.match(isolated.cookie, /^open_fitness_isolated_session=/);
  assert.doesNotMatch(isolated.cookie, /^edward_fitness_session=/);

  const invalid = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(policyUrl)});`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FITNESS_OWNER_SESSION_COOKIE_NAME: "invalid cookie name",
      },
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be a safe cookie identifier/);
});

test("unsafe browser requests require the exact configured Origin", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 17),
  });
  assert.equal(
    policy.isOwnerAuthConfigured({
      nodeEnv: "production",
      passwordHash,
      publicOrigin: PUBLIC_ORIGIN,
      sessionSecret: SESSION_SECRET,
    }),
    true,
  );
  assert.equal(
    policy.isOwnerAuthConfigured({
      nodeEnv: "production",
      passwordHash,
      sessionSecret: SESSION_SECRET,
    }),
    false,
  );
  assert.equal(
    policy.isOwnerAuthConfigured({
      nodeEnv: "development",
      passwordHash,
      sessionSecret: SESSION_SECRET,
    }),
    true,
  );
  assert.equal(
    policy.isOwnerAuthConfigured({
      nodeEnv: "unknown",
      passwordHash,
      publicOrigin: PUBLIC_ORIGIN,
      sessionSecret: SESSION_SECRET,
    }),
    false,
  );
  assert.equal(
    policy.isOwnerAuthConfigured({
      nodeEnv: "production",
      passwordHash,
      publicOrigin: `${PUBLIC_ORIGIN}/path`,
      sessionSecret: SESSION_SECRET,
    }),
    false,
  );
  const sameOrigin = new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
    method: "POST",
    headers: { origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
  });
  assert.equal(
    policy.isTrustedMutationOrigin(sameOrigin, {
      nodeEnv: "production",
      publicOrigin: PUBLIC_ORIGIN,
    }),
    true,
  );
  for (const request of [
    new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
      method: "POST",
    }),
    new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN, "sec-fetch-site": "cross-site" },
    }),
  ]) {
    assert.equal(
      policy.isTrustedMutationOrigin(request, {
        nodeEnv: "production",
        publicOrigin: PUBLIC_ORIGIN,
      }),
      false,
    );
  }
  assert.equal(
    policy.isTrustedMutationOrigin(
      new Request("http://127.0.0.1:3311/auth/login", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3311" },
      }),
      { nodeEnv: "development" },
    ),
    true,
  );
  assert.equal(
    policy.isTrustedMutationOrigin(sameOrigin, { nodeEnv: "production" }),
    false,
  );
  assert.equal(
    policy.isTrustedMutationOrigin(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`),
      { nodeEnv: "production", publicOrigin: PUBLIC_ORIGIN },
    ),
    true,
  );
});

test("return paths stay local and avoid authentication endpoints", async () => {
  const policy = await ownerPolicy();
  assert.equal(policy.safeOwnerReturnPath("/?tab=nutrition#today"), "/?tab=nutrition#today");
  assert.equal(policy.safeOwnerReturnPath("https://evil.example/"), "/");
  assert.equal(policy.safeOwnerReturnPath("//evil.example/"), "/");
  assert.equal(policy.safeOwnerReturnPath("/login?again=1"), "/");
  assert.equal(policy.safeOwnerReturnPath("/auth/logout"), "/");
  assert.equal(policy.ownerLoginPath("/?tab=progress"), "/login?return_to=%2F%3Ftab%3Dprogress");
});

test("API actor resolution gives explicit Authorization precedence over cookies", async () => {
  const owner = await ownerPolicy();
  const policy = await apiPolicy();
  const passwordHash = await owner.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 21),
  });
  const token = owner.createOwnerSessionToken({
    passwordHash,
    sessionSecret: SESSION_SECRET,
    nowMs: NOW_MS,
  });
  const cookie = `${owner.OWNER_SESSION_COOKIE_NAME}=${token}`;
  const options = {
    apiToken: "automation-token",
    allowLocalPreview: false,
    nodeEnv: "production",
    ownerPasswordHash: passwordHash,
    ownerPublicOrigin: PUBLIC_ORIGIN,
    ownerSessionSecret: SESSION_SECRET,
    nowMs: NOW_MS,
  };

  assert.deepEqual(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { cookie },
      }),
      options,
    ),
    owner.OWNER_ACTOR,
  );
  assert.equal(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { cookie },
      }),
      { ...options, ownerPublicOrigin: undefined },
    ),
    null,
  );
  assert.equal(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { cookie },
      }),
      { ...options, nodeEnv: "unknown" },
    ),
    null,
  );
  assert.equal(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { authorization: "Bearer wrong", cookie },
      }),
      options,
    ),
    null,
  );
  assert.deepEqual(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { authorization: "Bearer automation-token", cookie },
      }),
      options,
    ),
    { id: "open-fitness-agent", kind: "fitness-agent" },
  );
  assert.equal(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
        method: "POST",
        headers: { cookie, origin: "https://evil.example" },
      }),
      options,
    ),
    null,
  );
  assert.deepEqual(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/body-measurements`, {
        method: "POST",
        headers: { cookie, origin: PUBLIC_ORIGIN },
      }),
      options,
    ),
    owner.OWNER_ACTOR,
  );
  assert.equal(
    policy.resolveApiActor(
      new Request(`${PUBLIC_ORIGIN}/api/fitness/snapshot`, {
        headers: { "oai-authenticated-user-email": "forged@example.invalid" },
      }),
      options,
    ),
    null,
  );
});

test("login route throttles failures per trusted proxy client and clears on success", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 30),
  });
  const previous = Object.fromEntries(
    [
      "NODE_ENV",
      "FITNESS_OWNER_PASSWORD_HASH",
      "FITNESS_SESSION_SECRET",
      "FITNESS_PUBLIC_ORIGIN",
    ].map((name) => [name, process.env[name]]),
  );
  process.env.FITNESS_OWNER_PASSWORD_HASH = passwordHash;
  process.env.FITNESS_SESSION_SECRET = SESSION_SECRET;
  process.env.FITNESS_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.NODE_ENV = "test";

  try {
    const login = await import(
      `${new URL("../app/auth/login/route.ts", import.meta.url).href}?owner-throttle-contract`
    );
    const loginRequest = (password, clientAddress) =>
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: PUBLIC_ORIGIN,
          ...trustedProxyHeaders(clientAddress),
        },
        body: new URLSearchParams({ password, return_to: "/?tab=progress" }),
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await login.POST(loginRequest(OTHER_PASSWORD, "192.0.2.20"));
      assert.equal(failure.status, 303);
      assert.match(failure.headers.get("location") ?? "", /^\/login\?/);
    }
    const throttled = await login.POST(
      loginRequest(OTHER_PASSWORD, "192.0.2.20"),
    );
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("set-cookie"), null);
    assert.match(throttled.headers.get("cache-control") ?? "", /private/);
    assert.match(throttled.headers.get("cache-control") ?? "", /no-store/);
    const retryAfter = Number(throttled.headers.get("retry-after"));
    assert.equal(Number.isInteger(retryAfter), true);
    assert.equal(retryAfter >= 1 && retryAfter <= 15 * 60, true);
    const throttledBody = await throttled.text();
    assert.equal(throttledBody.includes(PASSWORD), false);
    assert.equal(throttledBody.includes("192.0.2.20"), false);

    const separateClient = await login.POST(
      loginRequest(PASSWORD, "192.0.2.21"),
    );
    assert.equal(separateClient.status, 303);
    assert.match(separateClient.headers.get("set-cookie") ?? "", /HttpOnly/);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failure = await login.POST(loginRequest(OTHER_PASSWORD, "192.0.2.22"));
      assert.equal(failure.status, 303);
    }
    const clearsFailures = await login.POST(
      loginRequest(PASSWORD, "192.0.2.22"),
    );
    assert.equal(clearsFailures.status, 303);
    assert.match(clearsFailures.headers.get("set-cookie") ?? "", /HttpOnly/);
    const afterSuccess = await login.POST(
      loginRequest(OTHER_PASSWORD, "192.0.2.22"),
    );
    assert.equal(afterSuccess.status, 303);

    const parallel = await Promise.all(
      Array.from({ length: 6 }, () =>
        login.POST(loginRequest(OTHER_PASSWORD, "192.0.2.23")),
      ),
    );
    assert.deepEqual(
      parallel.map((response) => response.status).sort(),
      [303, 303, 303, 303, 303, 429],
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("login route releases reservations when password verification throws", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 42),
  });
  const previous = Object.fromEntries(
    [
      "NODE_ENV",
      "FITNESS_OWNER_PASSWORD_HASH",
      "FITNESS_SESSION_SECRET",
      "FITNESS_PUBLIC_ORIGIN",
    ].map((name) => [name, process.env[name]]),
  );
  const originalScrypt = crypto.scrypt;
  process.env.FITNESS_OWNER_PASSWORD_HASH = passwordHash;
  process.env.FITNESS_SESSION_SECRET = SESSION_SECRET;
  process.env.FITNESS_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.NODE_ENV = "test";

  try {
    const login = await import(
      `${new URL("../app/auth/login/route.ts", import.meta.url).href}?owner-throttle-exception-contract`
    );
    const loginRequest = () =>
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: PUBLIC_ORIGIN,
          ...trustedProxyHeaders("192.0.2.24"),
        },
        body: new URLSearchParams({ password: OTHER_PASSWORD }),
      });

    crypto.scrypt = (...arguments_) => {
      const callback = arguments_.at(-1);
      queueMicrotask(() => callback(new Error("simulated verifier failure")));
    };
    syncBuiltinESMExports();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const unavailable = await login.POST(loginRequest());
      assert.equal(unavailable.status, 503);
    }

    crypto.scrypt = originalScrypt;
    syncBuiltinESMExports();
    const afterRecovery = await login.POST(loginRequest());
    assert.equal(afterRecovery.status, 303);
  } finally {
    crypto.scrypt = originalScrypt;
    syncBuiltinESMExports();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("login and logout routes fail closed and never return secrets", async () => {
  const policy = await ownerPolicy();
  const passwordHash = await policy.hashOwnerPassword(PASSWORD, {
    salt: Buffer.alloc(16, 31),
  });
  const previous = Object.fromEntries(
    [
      "NODE_ENV",
      "FITNESS_OWNER_PASSWORD_HASH",
      "FITNESS_SESSION_SECRET",
      "FITNESS_PUBLIC_ORIGIN",
    ].map((name) => [name, process.env[name]]),
  );
  process.env.FITNESS_OWNER_PASSWORD_HASH = passwordHash;
  process.env.FITNESS_SESSION_SECRET = SESSION_SECRET;
  process.env.FITNESS_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.NODE_ENV = "test";

  try {
    const login = await import(
      `${new URL("../app/auth/login/route.ts", import.meta.url).href}?owner-contract`
    );
    const logout = await import(
      `${new URL("../app/auth/logout/route.ts", import.meta.url).href}?owner-contract`
    );
    const loginRequest = (password, origin = PUBLIC_ORIGIN) =>
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({ password, return_to: "/?tab=progress" }),
      });

    const wrong = await login.POST(loginRequest(OTHER_PASSWORD));
    assert.equal(wrong.status, 303);
    assert.match(wrong.headers.get("location") ?? "", /^\/login\?/);
    assert.equal(wrong.headers.get("set-cookie"), null);
    assert.match(wrong.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(await wrong.text(), "");

    const crossSite = await login.POST(
      loginRequest(PASSWORD, "https://evil.example"),
    );
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get("set-cookie"), null);

    const unsupported = await login.POST(
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    assert.equal(unsupported.status, 415);

    const oversized = await login.POST(
      new Request(`${PUBLIC_ORIGIN}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: PUBLIC_ORIGIN,
        },
        body: new URLSearchParams({ password: "x".repeat(20_000) }),
      }),
    );
    assert.equal(oversized.status, 413);

    const correct = await login.POST(loginRequest(PASSWORD));
    assert.equal(correct.status, 303);
    assert.equal(correct.headers.get("location"), "/?tab=progress");
    assert.match(correct.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(correct.headers.get("cache-control") ?? "", /no-store/);
    const correctBody = await correct.text();
    assert.equal(correctBody.includes(PASSWORD), false);
    assert.equal(correctBody.includes(SESSION_SECRET), false);

    delete process.env.FITNESS_SESSION_SECRET;
    const unconfigured = await login.POST(loginRequest(PASSWORD));
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.headers.get("set-cookie"), null);
    process.env.FITNESS_SESSION_SECRET = SESSION_SECRET;

    const crossSiteLogout = await logout.POST(
      new Request(`${PUBLIC_ORIGIN}/auth/logout`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    assert.equal(crossSiteLogout.status, 403);
    assert.equal(crossSiteLogout.headers.get("set-cookie"), null);

    const logoutResponse = await logout.POST(
      new Request(`${PUBLIC_ORIGIN}/auth/logout`, {
        method: "POST",
        headers: { origin: PUBLIC_ORIGIN },
      }),
    );
    assert.equal(logoutResponse.status, 303);
    assert.equal(logoutResponse.headers.get("location"), "/login");
    assert.match(logoutResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.match(logoutResponse.headers.get("cache-control") ?? "", /no-store/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the native source graph no longer trusts ChatGPT browser headers", () => {
  assert.equal(existsSync(new URL("../app/chatgpt-auth.ts", import.meta.url)), false);
  for (const path of [
    "app/page.tsx",
    "lib/api-auth.ts",
  ]) {
    const text = source(path);
    assert.doesNotMatch(text, /oai-authenticated-|chatgpt-user|ChatGPTUser/);
  }
  assert.match(source("app/page.tsx"), /requireOwner\(/);
  assert.match(source("lib/api-auth.ts"), /resolveApiActor\(/);
  for (const path of [
    "app/login/page.tsx",
    "app/auth/login/route.ts",
    "app/auth/logout/route.ts",
    "lib/owner-auth.ts",
    "lib/owner-auth-policy.mjs",
    "lib/owner-login-throttle.d.mts",
    "lib/owner-login-throttle.mjs",
    "scripts/hash-owner-password.mjs",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
  }
});
