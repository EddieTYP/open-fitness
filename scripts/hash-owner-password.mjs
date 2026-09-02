#!/usr/bin/env node

import { hashOwnerPassword } from "../lib/owner-auth-policy.mjs";

const MAX_INPUT_BYTES = 4_096;

async function readPassword() {
  if (process.stdin.isTTY) {
    throw new Error(
      "Read the owner password from stdin so it does not appear in shell history.",
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw new Error("Owner password input is too large.");
    }
    chunks.push(chunk);
  }
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (password.includes("\n") || password.includes("\r")) {
    throw new Error("Owner password must be provided as one line.");
  }
  return password;
}

try {
  const password = await readPassword();
  const passwordHash = await hashOwnerPassword(password);
  process.stdout.write(`${passwordHash}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unable to hash password.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
