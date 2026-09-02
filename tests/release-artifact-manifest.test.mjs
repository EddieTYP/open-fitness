import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifyManifest,
  writeManifest,
} from "../scripts/release-artifact-manifest.mjs";

function root() {
  return realpathSync(mkdtempSync(join(tmpdir(), "edward-fitness-artifact-manifest-")));
}

test("artifact manifest binds generated files and in-root symlinks", () => {
  const directory = root();
  try {
    writeFileSync(join(directory, "generated.js"), "first\n", { mode: 0o600 });
    symlinkSync("generated.js", join(directory, "generated-link"));
    const manifest = join(directory, "ARTIFACT-MANIFEST.json");
    assert.equal(writeManifest(directory, manifest), 2);
    assert.equal(verifyManifest(directory, manifest), 2);
    writeFileSync(join(directory, "generated.js"), "other\n", { mode: 0o600 });
    assert.throws(
      () => verifyManifest(directory, manifest),
      /does not match ARTIFACT-MANIFEST/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact manifest rejects symlinks outside the release root", () => {
  const directory = root();
  try {
    symlinkSync("/etc/hosts", join(directory, "outside"));
    assert.throws(
      () => writeManifest(directory, join(directory, "ARTIFACT-MANIFEST.json")),
      /symlink escapes release root/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
