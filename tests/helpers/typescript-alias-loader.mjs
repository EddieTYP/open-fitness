import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function resolve(specifier, context, nextResolve) {
  const isAlias = specifier.startsWith("@/");
  const isRelative = specifier.startsWith(".") && context.parentURL;
  if (!isAlias && !isRelative) {
    return nextResolve(specifier, context);
  }

  const target = isAlias
    ? resolvePath(repositoryRoot, specifier.slice(2))
    : fileURLToPath(new URL(specifier, context.parentURL));
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mjs`,
    join(target, "index.ts"),
    join(target, "index.mjs"),
  ];
  const resolved = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!resolved) {
    return nextResolve(specifier, context);
  }
  return { url: pathToFileURL(resolved).href, shortCircuit: true };
}
