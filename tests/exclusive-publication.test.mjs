import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/rename-exclusive.py", import.meta.url));

function root() {
  return realpathSync(mkdtempSync(join(tmpdir(), "edward-fitness-exclusive-rename-")));
}

function run(source, destination) {
  return spawnSync("/usr/bin/python3", [helper, source, destination], {
    encoding: "utf8",
  });
}

test("exclusive rename publishes one entry with preserved identity", () => {
  const directory = root();
  try {
    const source = join(directory, ".private-source");
    const destination = join(directory, "published");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "sentinel"), "owned", { mode: 0o600 });
    chmodSync(join(source, "sentinel"), 0o400);
    chmodSync(source, 0o500);
    const identity = lstatSync(source);
    let result = run(source, destination);
    if (result.status !== 0) {
      chmodSync(source, 0o700);
      result = run(source, destination);
    }
    assert.equal(result.status, 0, result.stderr);
    chmodSync(destination, 0o500);
    assert.equal(existsSync(source), false);
    const published = lstatSync(destination);
    assert.deepEqual([published.dev, published.ino], [identity.dev, identity.ino]);
    assert.equal(published.mode & 0o222, 0);
    assert.equal(lstatSync(join(destination, "sentinel")).mode & 0o222, 0);
  } finally {
    for (const name of [".private-source", "published"]) {
      const entry = join(directory, name);
      if (!existsSync(entry)) continue;
      chmodSync(entry, 0o700);
      const sentinel = join(entry, "sentinel");
      if (existsSync(sentinel)) chmodSync(sentinel, 0o600);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exclusive rename never replaces a racing destination or traverses a symlink parent", () => {
  const directory = root();
  try {
    const source = join(directory, ".private-source");
    const destination = join(directory, "published");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(destination, { mode: 0o700 });
    writeFileSync(join(destination, "sentinel"), "competitor", { mode: 0o600 });
    const collision = run(source, destination);
    assert.notEqual(collision.status, 0);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(join(destination, "sentinel")), true);

    const alias = join(directory, "alias");
    symlinkSync(directory, alias);
    const throughAlias = run(source, join(alias, "other"));
    assert.notEqual(throughAlias.status, 0);
    assert.equal(existsSync(source), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
