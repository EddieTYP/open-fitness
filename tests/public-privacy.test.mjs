import assert from "node:assert/strict";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ignoredDirectories = new Set([".git", ".next", "dist", "node_modules"]);
const forbiddenArtifactExtensions = new Set([
  ".cer",
  ".crt",
  ".db",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3",
]);
const expectedDocumentationImages = new Set([
  "docs/assets/open-fitness-nutrition-mobile.png",
  "docs/assets/open-fitness-today-mobile.png",
]);
const disallowedPngMetadataChunks = new Set([
  "eXIf",
  "iCCP",
  "iTXt",
  "tEXt",
  "zTXt",
]);

function publicFiles(directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...publicFiles(path));
    else files.push(path);
  }
  return files;
}

function pngChunkTypes(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(buffer.subarray(0, signature.length), signature);
  const chunks = [];
  let offset = signature.length;
  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, "PNG chunk is truncated");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    chunks.push(type);
    offset += 12 + length;
  }
  assert.equal(offset, buffer.length, "PNG has trailing or malformed data");
  assert.equal(chunks.at(-1), "IEND");
  return chunks;
}

test("public tree excludes host identity and secret-bearing artifacts", () => {
  const files = publicFiles();
  for (const path of files) {
    const name = basename(path);
    const publicPath = relative(root, path);
    const metadata = lstatSync(path);
    assert.equal(metadata.isSymbolicLink(), false, `${publicPath} is a symlink`);
    assert.equal(
      name.startsWith(".env") && name !== ".env.example",
      false,
      `${publicPath} is a private environment file`,
    );
    assert.equal(
      forbiddenArtifactExtensions.has(extname(name).toLowerCase()),
      false,
      `${publicPath} is a private runtime artifact`,
    );
    assert.doesNotMatch(
      name,
      /^(?:id_(?:dsa|ecdsa|ed25519|rsa)|.*(?:-wal|-shm))$/i,
      `${publicPath} is a private runtime artifact`,
    );

    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue;
    const source = buffer.toString("utf8");
    assert.doesNotMatch(
      source,
      /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?:\/|\\)/,
      `${publicPath} contains a literal home directory`,
    );
    assert.doesNotMatch(
      source,
      /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/,
      `${publicPath} contains a literal Windows home directory`,
    );
    assert.doesNotMatch(
      source,
      /@[A-Za-z0-9_]+bot\b/i,
      `${publicPath} contains a bot identity`,
    );
    assert.doesNotMatch(
      source,
      /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/,
      `${publicPath} contains a private key`,
    );

    if (
      /^(?:README(?:_[^.]+)?\.md|SECURITY\.md|docs\/|app\/|components\/|lib\/|scripts\/|integrations\/|agent-plugin\/)/.test(
        publicPath,
      )
    ) {
      assert.doesNotMatch(
        source,
        /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b/,
        `${publicPath} contains a literal private-network endpoint`,
      );
    }
  }
});

test("public package omits the private deployment surface", () => {
  const paths = new Set(publicFiles().map((path) => relative(root, path)));
  assert.equal([...paths].some((path) => path.startsWith("deploy/")), false);
  assert.equal(paths.has("docs/operations/LOCAL-HOSTING.md"), false);
  assert.equal(paths.has("scripts/activate-live-release.mjs"), false);
  assert.equal(paths.has("scripts/replace-live-sqlite.mjs"), false);
});

test("documentation screenshots are fixed PNGs without embedded metadata", () => {
  const paths = new Set(publicFiles().map((path) => relative(root, path)));
  for (const path of expectedDocumentationImages) {
    assert.equal(paths.has(path), true, `${path} is missing`);
    const chunks = pngChunkTypes(readFileSync(join(root, path)));
    for (const chunk of chunks) {
      assert.equal(
        disallowedPngMetadataChunks.has(chunk),
        false,
        `${path} contains metadata chunk ${chunk}`,
      );
    }
  }
});
