#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORMAT = "edward-fitness-release-artifact-manifest";
const EXCLUDED = new Set(["ARTIFACT-MANIFEST.json", "RELEASE-EVIDENCE.json"]);

function fail(message) {
  throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedRoot(value) {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    fail("Release root must be a normalized absolute path");
  }
  const root = realpathSync(value);
  if (root !== value || !lstatSync(root).isDirectory()) {
    fail("Release root must be a real directory with no symlink alias");
  }
  return root;
}

function relativePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("/../")) {
    fail("Artifact path escaped release root");
  }
  return value;
}

function collectEntries(root) {
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        const path = join(directory, entry.name);
        const artifactPath = relativePath(root, path);
        if (EXCLUDED.has(artifactPath)) continue;
        const metadata = lstatSync(path);
        if (metadata.isDirectory()) {
          entries.push({ path: artifactPath, type: "directory" });
          pending.push(path);
        } else if (metadata.isFile()) {
          entries.push({
            path: artifactPath,
            type: "file",
            executable: (metadata.mode & 0o111) !== 0,
            size: metadata.size,
            sha256: sha256File(path),
          });
        } else if (metadata.isSymbolicLink()) {
          const target = readlinkSync(path);
          const resolvedTarget = realpathSync(path);
          if (
            resolvedTarget !== root &&
            !resolvedTarget.startsWith(`${root}${sep}`)
          ) {
            fail(`Artifact symlink escapes release root at ${artifactPath}`);
          }
          entries.push({
            path: artifactPath,
            type: "symlink",
            target,
            targetSha256: createHash("sha256").update(target).digest("hex"),
          });
        } else {
          fail(`Unsupported artifact type at ${artifactPath}`);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function manifest(root) {
  return {
    format: FORMAT,
    formatVersion: 1,
    entries: collectEntries(root),
  };
}

function validateManifestShape(value) {
  if (
    !value ||
    value.format !== FORMAT ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.entries) ||
    Object.keys(value).sort().join(",") !== "entries,format,formatVersion"
  ) {
    fail("Artifact manifest schema is invalid");
  }
  let previous = "";
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      entry.path <= previous ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..") ||
      EXCLUDED.has(entry.path)
    ) {
      fail("Artifact manifest path ordering or scope is invalid");
    }
    previous = entry.path;
    const keys = Object.keys(entry).sort().join(",");
    if (entry.type === "directory") {
      if (keys !== "path,type") fail("Artifact directory entry schema is invalid");
    } else if (entry.type === "file") {
      if (
        keys !== "executable,path,sha256,size,type" ||
        typeof entry.executable !== "boolean" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      ) {
        fail("Artifact file entry schema is invalid");
      }
    } else if (entry.type === "symlink") {
      if (
        keys !== "path,target,targetSha256,type" ||
        typeof entry.target !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.targetSha256)
      ) {
        fail("Artifact symlink entry schema is invalid");
      }
    } else {
      fail("Artifact entry type is invalid");
    }
  }
}

function writeManifest(root, output) {
  if (output !== join(root, "ARTIFACT-MANIFEST.json")) {
    fail("Artifact manifest output path is fixed within the release root");
  }
  const value = manifest(root);
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(output, 0o600);
  return value.entries.length;
}

function verifyManifest(root, input) {
  if (input !== join(root, "ARTIFACT-MANIFEST.json")) {
    fail("Artifact manifest input path is fixed within the release root");
  }
  const expectedText = readFileSync(input, "utf8");
  if (!expectedText.endsWith("\n")) fail("Artifact manifest must end with one newline");
  const expected = JSON.parse(expectedText);
  validateManifestShape(expected);
  const actual = manifest(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("Release artifact tree does not match ARTIFACT-MANIFEST.json");
  }
  return actual.entries.length;
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  process.umask(0o077);
  const [action, rootValue, manifestPathValue] = process.argv.slice(2);
  try {
    const root = normalizedRoot(rootValue);
    const manifestPath = resolve(manifestPathValue ?? "");
    const entryCount =
      action === "create"
        ? writeManifest(root, manifestPath)
        : action === "verify"
          ? verifyManifest(root, manifestPath)
          : fail("Action must be create or verify");
    process.stdout.write(`${JSON.stringify({ ok: true, action, entryCount })}\n`);
  } catch (error) {
    process.stderr.write(`Artifact manifest failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { collectEntries, validateManifestShape, verifyManifest, writeManifest };
