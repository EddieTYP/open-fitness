import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, } from "node:crypto";
export const OWNER_ACTOR = Object.freeze({
    id: "edward-fitness-owner",
    kind: "owner",
});
const DEFAULT_OWNER_SESSION_COOKIE_NAME = "edward_fitness_session";
const configuredOwnerSessionCookieName = process.env.FITNESS_OWNER_SESSION_COOKIE_NAME?.trim();
if (configuredOwnerSessionCookieName &&
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(configuredOwnerSessionCookieName)) {
    throw new Error("FITNESS_OWNER_SESSION_COOKIE_NAME must be a safe cookie identifier");
}
export const OWNER_SESSION_COOKIE_NAME = configuredOwnerSessionCookieName || DEFAULT_OWNER_SESSION_COOKIE_NAME;
export const OWNER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_HASH_ALGORITHM = "scrypt";
const PASSWORD_HASH_VERSION = "1";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1_024;
const MIN_SESSION_SECRET_BYTES = 32;
const MAX_SESSION_SECRET_BYTES = 4_096;
const MAX_SESSION_TOKEN_LENGTH = 4_096;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOCAL_ORIGIN = "https://app.local";
function constantTimeEqual(left, right) {
    return left.length === right.length && timingSafeEqual(left, right);
}
function strictBase64Url(value, expectedLength) {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
        return null;
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== value)
        return null;
    if (expectedLength !== undefined && decoded.length !== expectedLength)
        return null;
    return decoded;
}
function parseOwnerPasswordHash(value) {
    const parts = value.split("$");
    if (parts.length !== 7 ||
        parts[0] !== PASSWORD_HASH_ALGORITHM ||
        parts[1] !== PASSWORD_HASH_VERSION ||
        parts[2] !== String(SCRYPT_N) ||
        parts[3] !== String(SCRYPT_R) ||
        parts[4] !== String(SCRYPT_P)) {
        return null;
    }
    const salt = strictBase64Url(parts[5], SCRYPT_SALT_LENGTH);
    const digest = strictBase64Url(parts[6], SCRYPT_KEY_LENGTH);
    return salt && digest ? { salt, digest } : null;
}
function derivePasswordKey(password, salt) {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, SCRYPT_KEY_LENGTH, {
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            maxmem: SCRYPT_MAX_MEMORY,
        }, (error, key) => {
            if (error)
                reject(error);
            else
                resolve(key);
        });
    });
}
function unicodeCharacterCount(password, stopAfter) {
    let count = 0;
    let offset = 0;
    while (offset < password.length) {
        const codePoint = password.codePointAt(offset);
        offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        count += 1;
        if (count > stopAfter)
            break;
    }
    return count;
}
function usableNewPassword(password) {
    const length = unicodeCharacterCount(password, MAX_PASSWORD_LENGTH);
    return length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH;
}
function usableLegacyPassword(password) {
    // Verification intentionally keeps accepting 1-character legacy passwords;
    // its Unicode maximum is a superset of the original UTF-16 length limit.
    const length = unicodeCharacterCount(password, MAX_PASSWORD_LENGTH);
    return length > 0 && length <= MAX_PASSWORD_LENGTH;
}
function normalizeSessionSecret(value) {
    const normalized = value.trim();
    const size = Buffer.byteLength(normalized, "utf8");
    if (size < MIN_SESSION_SECRET_BYTES || size > MAX_SESSION_SECRET_BYTES) {
        return null;
    }
    return normalized;
}
function passwordHashFingerprint(passwordHash) {
    return createHash("sha256")
        .update(passwordHash, "utf8")
        .digest("base64url")
        .slice(0, 22);
}
function sessionSignature(payload, sessionSecret) {
    return createHmac("sha256", sessionSecret).update(payload, "utf8").digest();
}
function parseSessionPayload(encoded) {
    const bytes = strictBase64Url(encoded);
    if (!bytes || bytes.length > 512)
        return null;
    try {
        const payload = JSON.parse(bytes.toString("utf8"));
        if (payload.v !== 1 ||
            payload.sub !== OWNER_ACTOR.id ||
            !Number.isSafeInteger(payload.iat) ||
            !Number.isSafeInteger(payload.exp) ||
            typeof payload.ph !== "string" ||
            !/^[A-Za-z0-9_-]{22}$/.test(payload.ph)) {
            return null;
        }
        return payload;
    }
    catch {
        return null;
    }
}
function ownerSessionCookieValues(header) {
    if (!header || header.length > 16_384)
        return [];
    const values = [];
    for (const item of header.split(";")) {
        const separator = item.indexOf("=");
        if (separator < 0)
            continue;
        const name = item.slice(0, separator).trim();
        if (name !== OWNER_SESSION_COOKIE_NAME)
            continue;
        values.push(item.slice(separator + 1).trim());
    }
    return values;
}
function ownerSessionFromCookieHeader(header) {
    const values = ownerSessionCookieValues(header);
    return values.length === 1 && values[0].length <= MAX_SESSION_TOKEN_LENGTH
        ? values[0]
        : null;
}
function normalizedOrigin(value) {
    if (!value)
        return null;
    try {
        const url = new URL(value.trim());
        if ((url.protocol !== "https:" && url.protocol !== "http:") ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash) {
            return null;
        }
        return url.origin;
    }
    catch {
        return null;
    }
}
function requestOrigin(request) {
    try {
        return new URL(request.url).origin;
    }
    catch {
        return null;
    }
}
function isReservedOwnerAuthPath(pathname) {
    return pathname === "/login" || pathname.startsWith("/auth/");
}
function cookieBase(secure) {
    return [
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        ...(secure ? ["Secure"] : []),
    ];
}
export function isOwnerPasswordHash(value) {
    return parseOwnerPasswordHash(value.trim()) !== null;
}
export async function hashOwnerPassword(password, options = {}) {
    if (!usableNewPassword(password)) {
        throw new Error("Owner password must contain 12 to 1024 Unicode characters");
    }
    const salt = options.salt ? Buffer.from(options.salt) : randomBytes(SCRYPT_SALT_LENGTH);
    if (salt.length !== SCRYPT_SALT_LENGTH) {
        throw new Error(`Owner password salt must be ${SCRYPT_SALT_LENGTH} bytes`);
    }
    const digest = await derivePasswordKey(password, salt);
    return [
        PASSWORD_HASH_ALGORITHM,
        PASSWORD_HASH_VERSION,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString("base64url"),
        digest.toString("base64url"),
    ].join("$");
}
export async function verifyOwnerPassword(password, encodedHash) {
    if (!usableLegacyPassword(password))
        return false;
    const parsed = parseOwnerPasswordHash(encodedHash.trim());
    if (!parsed)
        return false;
    const digest = await derivePasswordKey(password, parsed.salt);
    return constantTimeEqual(digest, parsed.digest);
}
export function isOwnerAuthConfigured(options) {
    const knownEnvironment = options.nodeEnv === "production" ||
        options.nodeEnv === "development" ||
        options.nodeEnv === "test";
    const publicOrigin = normalizedOrigin(options.publicOrigin);
    if (!knownEnvironment ||
        (options.publicOrigin && !publicOrigin) ||
        (options.nodeEnv === "production" && !publicOrigin)) {
        return false;
    }
    return Boolean(options.passwordHash &&
        isOwnerPasswordHash(options.passwordHash) &&
        options.sessionSecret &&
        normalizeSessionSecret(options.sessionSecret));
}
export function createOwnerSessionToken(options) {
    const passwordHash = options.passwordHash.trim();
    const sessionSecret = normalizeSessionSecret(options.sessionSecret);
    if (!isOwnerPasswordHash(passwordHash) || !sessionSecret) {
        throw new Error("Owner authentication is not configured safely");
    }
    const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const payload = {
        v: 1,
        sub: OWNER_ACTOR.id,
        iat: issuedAt,
        exp: issuedAt + OWNER_SESSION_TTL_SECONDS,
        ph: passwordHashFingerprint(passwordHash),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sessionSignature(encoded, sessionSecret).toString("base64url");
    return `${encoded}.${signature}`;
}
export function verifyOwnerSessionToken(token, options) {
    if (token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH)
        return null;
    const passwordHash = options.passwordHash.trim();
    const sessionSecret = normalizeSessionSecret(options.sessionSecret);
    if (!isOwnerPasswordHash(passwordHash) || !sessionSecret)
        return null;
    const parts = token.split(".");
    if (parts.length !== 2)
        return null;
    const suppliedSignature = strictBase64Url(parts[1], 32);
    if (!suppliedSignature)
        return null;
    const expectedSignature = sessionSignature(parts[0], sessionSecret);
    if (!constantTimeEqual(suppliedSignature, expectedSignature))
        return null;
    const payload = parseSessionPayload(parts[0]);
    if (!payload || payload.ph !== passwordHashFingerprint(passwordHash))
        return null;
    const now = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const lifetime = payload.exp - payload.iat;
    if (payload.iat < 0 ||
        payload.exp <= now ||
        payload.iat > now ||
        lifetime <= 0 ||
        lifetime > OWNER_SESSION_TTL_SECONDS) {
        return null;
    }
    return OWNER_ACTOR;
}
export function isTrustedMutationOrigin(request, options) {
    if (SAFE_METHODS.has(request.method.toUpperCase()))
        return true;
    const suppliedOrigin = normalizedOrigin(request.headers.get("origin") ?? undefined);
    if (!suppliedOrigin)
        return false;
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin")
        return false;
    const configuredOrigin = normalizedOrigin(options.publicOrigin);
    if (options.publicOrigin && !configuredOrigin)
        return false;
    const isKnownNonProduction = options.nodeEnv === "development" || options.nodeEnv === "test";
    const expectedOrigin = configuredOrigin ?? (isKnownNonProduction ? requestOrigin(request) : null);
    return expectedOrigin !== null && suppliedOrigin === expectedOrigin;
}
export function getOwnerActorFromRequest(request, options) {
    if (request.headers.has("authorization"))
        return null;
    if (!isOwnerAuthConfigured(options))
        return null;
    const token = ownerSessionFromCookieHeader(request.headers.get("cookie"));
    if (!token)
        return null;
    const actor = verifyOwnerSessionToken(token, options);
    if (!actor || !isTrustedMutationOrigin(request, options))
        return null;
    return actor;
}
export function requestHasOwnerSessionCookie(request) {
    return ownerSessionCookieValues(request.headers.get("cookie")).length > 0;
}
export function serializeOwnerSessionCookie(token, options) {
    if (!token || token.length > MAX_SESSION_TOKEN_LENGTH || /[;\r\n]/.test(token)) {
        throw new Error("Invalid owner session token");
    }
    return [
        `${OWNER_SESSION_COOKIE_NAME}=${token}`,
        ...cookieBase(options.secure),
        `Max-Age=${OWNER_SESSION_TTL_SECONDS}`,
    ].join("; ");
}
export function serializeClearedOwnerSessionCookie(options) {
    return [
        `${OWNER_SESSION_COOKIE_NAME}=`,
        ...cookieBase(options.secure),
        "Max-Age=0",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ].join("; ");
}
export function safeOwnerReturnPath(value) {
    if (!value.startsWith("/") || value.startsWith("//"))
        return "/";
    try {
        const url = new URL(value, LOCAL_ORIGIN);
        if (url.origin !== LOCAL_ORIGIN || isReservedOwnerAuthPath(url.pathname)) {
            return "/";
        }
        return `${url.pathname}${url.search}${url.hash}`;
    }
    catch {
        return "/";
    }
}
export function ownerLoginPath(returnTo) {
    return `/login?return_to=${encodeURIComponent(safeOwnerReturnPath(returnTo))}`;
}
