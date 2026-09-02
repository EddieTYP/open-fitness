import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const OWNER_LOGIN_FAILURE_LIMIT = 5;
export const OWNER_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
export const OWNER_LOGIN_MAX_CLIENTS = 256;

const DIRECT_CLIENT_KEY = "direct";
const OVERFLOW_CLIENT_KEY = Symbol("overflow");

function canonicalIpLiteral(value) {
  if (
    value.length === 0 ||
    value.length > 64 ||
    value !== value.trim() ||
    !/^[0-9A-Fa-f:.]+$/.test(value)
  ) {
    return null;
  }
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function ownerLoginClientKey(request) {
  const host = request.headers.get("host");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (
    !host ||
    forwardedHost !== host ||
    forwardedProto !== "https" ||
    !forwardedFor
  ) {
    return DIRECT_CLIENT_KEY;
  }
  const address = canonicalIpLiteral(forwardedFor);
  if (!address) return DIRECT_CLIENT_KEY;
  const digest = createHash("sha256").update(address, "utf8").digest("base64url");
  return `forwarded:${digest}`;
}

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function createOwnerLoginThrottle(options = {}) {
  const failureLimit = positiveInteger(
    options.failureLimit ?? OWNER_LOGIN_FAILURE_LIMIT,
    "failureLimit",
  );
  const windowMs = positiveInteger(
    options.windowMs ?? OWNER_LOGIN_FAILURE_WINDOW_MS,
    "windowMs",
  );
  const maxClients = positiveInteger(
    options.maxClients ?? OWNER_LOGIN_MAX_CLIENTS,
    "maxClients",
    2,
  );
  const failures = new Map();

  function prune(nowMs) {
    for (const [key, state] of failures) {
      state.failures = state.failures.filter(
        (failure) => nowMs < failure.atMs + windowMs,
      );
      if (state.failures.length === 0) failures.delete(key);
    }
  }

  function existingStateKey(clientKey) {
    if (failures.has(clientKey)) return clientKey;
    if (failures.has(OVERFLOW_CLIENT_KEY)) return OVERFLOW_CLIENT_KEY;
    return null;
  }

  function stateKeyForNewFailure(clientKey) {
    const existingKey = existingStateKey(clientKey);
    if (existingKey !== null) return existingKey;
    // Reserve one bounded bucket for additional clients instead of evicting a
    // blocked client and letting address churn reset its failure count.
    return failures.size < maxClients - 1 ? clientKey : OVERFLOW_CLIENT_KEY;
  }

  function retryAfterSeconds(clientKey, nowMs = Date.now()) {
    prune(nowMs);
    const key = existingStateKey(clientKey);
    if (key === null) return null;
    const state = failures.get(key);
    if (state.failures.length < failureLimit) return null;
    const earliestFailureMs = Math.min(
      ...state.failures.map((failure) => failure.atMs),
    );
    return Math.max(
      1,
      Math.ceil((earliestFailureMs + windowMs - nowMs) / 1_000),
    );
  }

  function reserveFailure(clientKey, nowMs = Date.now()) {
    prune(nowMs);
    const key = stateKeyForNewFailure(clientKey);
    let state = failures.get(key);
    if (!state) {
      state = { failures: [] };
      failures.set(key, state);
    }
    const failure = { atMs: nowMs };
    state.failures.push(failure);
    if (state.failures.length > failureLimit) state.failures.shift();
    let active = true;
    return function releaseFailure() {
      if (!active) return;
      active = false;
      if (failures.get(key) !== state) return;
      const index = state.failures.indexOf(failure);
      if (index === -1) return;
      state.failures.splice(index, 1);
      if (state.failures.length === 0) failures.delete(key);
    };
  }

  function clear(clientKey) {
    const key = existingStateKey(clientKey);
    if (key !== null) failures.delete(key);
  }

  return Object.freeze({
    retryAfterSeconds,
    reserveFailure,
    clear,
    get trackedClientCount() {
      return failures.size;
    },
  });
}
