import {
  createOwnerSessionToken,
  isOwnerAuthConfigured,
  isTrustedMutationOrigin,
  safeOwnerReturnPath,
  serializeOwnerSessionCookie,
  verifyOwnerPassword,
} from "../../../lib/owner-auth-policy.mjs";
import { readOwnerAuthEnvironment } from "../../../lib/owner-auth-env.mjs";
import {
  createOwnerLoginThrottle,
  ownerLoginClientKey,
} from "../../../lib/owner-login-throttle.mjs";

export const dynamic = "force-dynamic";

// A 1,024-code-point password can require 12 KiB when form percent-encoded.
const MAX_LOGIN_BODY_BYTES = 16_384;
const ownerLoginThrottle = createOwnerLoginThrottle();

class LoginBodyTooLargeError extends Error {}

async function readLimitedLoginBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LOGIN_BODY_BYTES) {
      await reader.cancel();
      throw new LoginBodyTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function privateHeaders(init: HeadersInit = {}) {
  const headers = new Headers(init);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function privateJson(value: unknown, status: number, init: HeadersInit = {}) {
  const headers = privateHeaders(init);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

function throttledResponse(retryAfterSeconds: number) {
  return privateJson({ error: "Too many login attempts" }, 429, {
    "Retry-After": String(retryAfterSeconds),
  });
}

function loginErrorPath(returnTo: string) {
  const params = new URLSearchParams({ error: "invalid" });
  if (returnTo !== "/") params.set("return_to", returnTo);
  return `/login?${params}`;
}

function redirectResponse(location: string, cookie?: string) {
  const headers = privateHeaders({ Location: location });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: Request) {
  const environment = readOwnerAuthEnvironment();
  if (
    !isTrustedMutationOrigin(request, {
      nodeEnv: environment.nodeEnv,
      publicOrigin: environment.publicOrigin ?? undefined,
    })
  ) {
    return privateJson({ error: "Request origin is not allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_LOGIN_BODY_BYTES
  ) {
    return privateJson({ error: "Login request is too large" }, 413);
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return privateJson({ error: "Unsupported login request" }, 415);
  }
  if (!isOwnerAuthConfigured(environment)) {
    return privateJson({ error: "Private owner login is unavailable" }, 503);
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readLimitedLoginBody(request));
  } catch (error) {
    if (error instanceof LoginBodyTooLargeError) {
      return privateJson({ error: "Login request is too large" }, 413);
    }
    return privateJson({ error: "Invalid login request" }, 400);
  }
  const passwords = form.getAll("password");
  const returnValues = form.getAll("return_to");
  if (passwords.length !== 1 || returnValues.length > 1) {
    return privateJson({ error: "Invalid login request" }, 400);
  }
  const password = passwords[0];
  const returnTo = safeOwnerReturnPath(returnValues[0] ?? "/");
  const clientKey = ownerLoginClientKey(request);
  const retryAfterSeconds = ownerLoginThrottle.retryAfterSeconds(clientKey);
  if (retryAfterSeconds !== null) return throttledResponse(retryAfterSeconds);

  // Reserve a failure slot before the expensive password check so a parallel
  // burst cannot exceed the process-local limit. A successful check clears it.
  const releaseFailure = ownerLoginThrottle.reserveFailure(clientKey);

  let validPassword = false;
  try {
    validPassword = await verifyOwnerPassword(password, environment.passwordHash!);
  } catch {
    releaseFailure();
    return privateJson({ error: "Private owner login is unavailable" }, 503);
  }
  if (!validPassword) return redirectResponse(loginErrorPath(returnTo));
  ownerLoginThrottle.clear(clientKey);

  const token = createOwnerSessionToken({
    passwordHash: environment.passwordHash!,
    sessionSecret: environment.sessionSecret!,
  });
  const cookie = serializeOwnerSessionCookie(token, {
    secure: environment.secureCookie,
  });
  return redirectResponse(returnTo, cookie);
}
