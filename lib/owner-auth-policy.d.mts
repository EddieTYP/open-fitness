export const OWNER_ACTOR: Readonly<{
  id: "edward-fitness-owner";
  kind: "owner";
}>;
export const OWNER_SESSION_COOKIE_NAME: string;
export const OWNER_SESSION_TTL_SECONDS: number;

export type OwnerActor = typeof OWNER_ACTOR;

export type OwnerSessionOptions = {
  passwordHash: string;
  sessionSecret: string;
  nowMs?: number;
};

export type OwnerRequestOptions = OwnerSessionOptions & {
  nodeEnv?: string;
  publicOrigin?: string;
};

export type MutationOriginOptions = {
  nodeEnv?: string;
  publicOrigin?: string;
};

export function isOwnerPasswordHash(value: string): boolean;
export function hashOwnerPassword(
  password: string,
  options?: { salt?: Uint8Array },
): Promise<string>;
export function verifyOwnerPassword(
  password: string,
  encodedHash: string,
): Promise<boolean>;
export function isOwnerAuthConfigured(options: {
  nodeEnv?: string;
  passwordHash?: string | null;
  publicOrigin?: string | null;
  sessionSecret?: string | null;
}): boolean;
export function createOwnerSessionToken(options: OwnerSessionOptions): string;
export function verifyOwnerSessionToken(
  token: string,
  options: OwnerSessionOptions,
): OwnerActor | null;
export function isTrustedMutationOrigin(
  request: Request,
  options: MutationOriginOptions,
): boolean;
export function getOwnerActorFromRequest(
  request: Request,
  options: OwnerRequestOptions,
): OwnerActor | null;
export function requestHasOwnerSessionCookie(request: Request): boolean;
export function serializeOwnerSessionCookie(
  token: string,
  options: { secure: boolean },
): string;
export function serializeClearedOwnerSessionCookie(options: {
  secure: boolean;
}): string;
export function safeOwnerReturnPath(value: string): string;
export function ownerLoginPath(returnTo: string): string;
