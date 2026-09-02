export type OwnerAuthEnvironment = {
  nodeEnv?: string;
  passwordHash: string | null;
  publicOrigin: string | null;
  secureCookie: boolean;
  sessionSecret: string | null;
};

export function readOwnerAuthEnvironment(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): OwnerAuthEnvironment;
