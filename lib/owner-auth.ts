import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  isOwnerAuthConfigured,
  OWNER_SESSION_COOKIE_NAME,
  ownerLoginPath,
  verifyOwnerSessionToken,
  type OwnerActor,
} from "@/lib/owner-auth-policy.mjs";
import { readOwnerAuthEnvironment } from "@/lib/owner-auth-env.mjs";

export function isOwnerRuntimeConfigured(): boolean {
  const secrets = readOwnerAuthEnvironment();
  return isOwnerAuthConfigured(secrets);
}

export async function getOwnerActor(): Promise<OwnerActor | null> {
  const environment = readOwnerAuthEnvironment();
  if (!isOwnerAuthConfigured(environment)) return null;
  const cookieStore = await cookies();
  const sessionCookies = cookieStore.getAll(OWNER_SESSION_COOKIE_NAME);
  if (sessionCookies.length !== 1) return null;
  const token = sessionCookies[0].value;
  return verifyOwnerSessionToken(token, {
    passwordHash: environment.passwordHash!,
    sessionSecret: environment.sessionSecret!,
  });
}

export async function requireOwner(returnTo: string): Promise<OwnerActor> {
  const owner = await getOwnerActor();
  if (owner) return owner;
  redirect(ownerLoginPath(returnTo));
}
