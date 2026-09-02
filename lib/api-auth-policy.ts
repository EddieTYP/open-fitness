import { createHash, timingSafeEqual } from "node:crypto";
import {
  getOwnerActorFromRequest,
  requestHasOwnerSessionCookie,
  type OwnerActor,
} from "./owner-auth-policy.mjs";

export type ApiActorKind = "fitness-agent" | "local-preview";

export type ApiActor = {
  id: string;
  kind: ApiActorKind;
};

export type AutomationActorOptions = {
  apiToken?: string;
  allowLocalPreview?: boolean;
  nodeEnv?: string;
};

export type ApiActorOptions = AutomationActorOptions & {
  nowMs?: number;
  ownerPasswordHash?: string;
  ownerPublicOrigin?: string;
  ownerSessionSecret?: string;
};

export type ResolvedApiActor = ApiActor | OwnerActor;

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function resolveAutomationActor(
  request: Request,
  options: AutomationActorOptions = {},
): ApiActor | null {
  const authorization = request.headers.get("authorization");
  const token =
    typeof options.apiToken === "string" && options.apiToken.trim().length > 0
      ? options.apiToken.trim()
      : null;

  if (authorization !== null) {
    if (!authorization.startsWith("Bearer ") || !token) return null;
    const suppliedToken = authorization.slice("Bearer ".length);
    if (
      suppliedToken.length > 0 &&
      constantTimeEqual(token, suppliedToken)
    ) {
      return { id: "open-fitness-agent", kind: "fitness-agent" };
    }
    return null;
  }

  const isKnownNonProduction =
    options.nodeEnv === "development" || options.nodeEnv === "test";
  if (options.allowLocalPreview && isKnownNonProduction) {
    return { id: "local-preview", kind: "local-preview" };
  }

  return null;
}

export function resolveApiActor(
  request: Request,
  options: ApiActorOptions = {},
): ResolvedApiActor | null {
  if (request.headers.has("authorization")) {
    return resolveAutomationActor(request, options);
  }

  if (options.ownerPasswordHash && options.ownerSessionSecret) {
    const ownerActor = getOwnerActorFromRequest(request, {
      passwordHash: options.ownerPasswordHash,
      publicOrigin: options.ownerPublicOrigin,
      sessionSecret: options.ownerSessionSecret,
      nodeEnv: options.nodeEnv,
      nowMs: options.nowMs,
    });
    if (ownerActor) return ownerActor;
  }
  if (requestHasOwnerSessionCookie(request)) return null;

  return resolveAutomationActor(request, options);
}
