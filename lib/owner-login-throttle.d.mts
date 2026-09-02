export const OWNER_LOGIN_FAILURE_LIMIT: number;
export const OWNER_LOGIN_FAILURE_WINDOW_MS: number;
export const OWNER_LOGIN_MAX_CLIENTS: number;

export type OwnerLoginThrottle = Readonly<{
  retryAfterSeconds(clientKey: string, nowMs?: number): number | null;
  reserveFailure(clientKey: string, nowMs?: number): () => void;
  clear(clientKey: string): void;
  readonly trackedClientCount: number;
}>;

export function ownerLoginClientKey(request: Request): string;
export function createOwnerLoginThrottle(options?: {
  failureLimit?: number;
  windowMs?: number;
  maxClients?: number;
}): OwnerLoginThrottle;
