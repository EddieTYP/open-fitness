import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import {
  API_ERROR_CODE_PATTERN,
  apiError,
} from "../lib/api-error.ts";
import {
  ApiActorResolutionError,
  routeError,
  unauthorizedResponse,
} from "../lib/api-route-error.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else files.push(path);
  }
  return files;
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) {
    return `${node.expression.expression.getText()}.${node.expression.name.text}`;
  }
  return null;
}

function propertyName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

async function authenticatedRoutes() {
  const routeFiles = (await filesBelow(`${repoRoot}/app/api`)).filter((path) =>
    path.endsWith("/route.ts"),
  );
  const routes = [];
  for (const absolutePath of routeFiles) {
    const relativePath = absolutePath.slice(repoRoot.length).replace(/^\/+/, "");
    const source = await readFile(absolutePath, "utf8");
    if (!source.includes("getApiActor")) {
      continue;
    }
    routes.push({ absolutePath, relativePath, source });
  }
  return routes.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

test("apiError always returns the structured locale-neutral envelope", async () => {
  const response = apiError(
    "INVALID_OWNER_INPUT",
    422,
    { ownerText: "深蹲 🏋️", source: "使用者輸入" },
    "Invalid owner input",
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    errorCode: "INVALID_OWNER_INPUT",
    facts: { ownerText: "深蹲 🏋️", source: "使用者輸入" },
    error: "Invalid owner input",
  });

  const withoutCompatibilityText = apiError("RESOURCE_NOT_FOUND", 404);
  assert.deepEqual(await withoutCompatibilityText.json(), {
    errorCode: "RESOURCE_NOT_FOUND",
    facts: {},
  });
});

test("apiError validates stable codes and neutral compatibility text", () => {
  for (const code of [
    "AUTHENTICATION_REQUIRED",
    "INVALID_REQUEST_2",
    "RESOURCE404_NOT_FOUND",
  ]) {
    assert.match(code, API_ERROR_CODE_PATTERN);
    assert.doesNotThrow(() => apiError(code, 400));
  }

  for (const code of ["localized-error", "錯誤", "_INVALID", "INVALID__CODE"] ) {
    assert.doesNotMatch(code, API_ERROR_CODE_PATTERN);
    assert.throws(() => apiError(code, 400), /Invalid API error code/);
  }
  assert.throws(
    () => apiError("INVALID_REQUEST", 400, {}, "資料格式錯誤"),
    /non-empty ASCII text/,
  );
  assert.throws(
    () => apiError("INVALID_REQUEST", 399),
    /Invalid API error status/,
  );
  assert.throws(
    () => apiError("INVALID_REQUEST", 400, []),
    /facts must be an object/,
  );
});

test("apiError redacts all internal facts and prose from 5xx responses", async () => {
  const response = apiError(
    "DATABASE_WRITE_FAILED",
    500,
    { driverMessage: "UNIQUE constraint failed", secret: "do-not-return" },
    "Database driver exploded",
  );

  assert.deepEqual(await response.json(), {
    errorCode: "DATABASE_WRITE_FAILED",
    facts: {},
    error: "Internal server error",
  });
});

test("authentication failures keep stable 401 and configuration-error semantics", async (t) => {
  assert.deepEqual(await unauthorizedResponse().json(), {
    errorCode: "AUTHENTICATION_REQUIRED",
    facts: {},
    error: "Authentication required",
  });

  t.mock.method(console, "error", () => {});
  const response = routeError(
    new ApiActorResolutionError(
      new Error("Invalid owner authentication configuration: 私密資料"),
    ),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    errorCode: "INTERNAL_ERROR",
    facts: {},
    error: "Internal server error",
  });
});

test("every assigned authenticated route uses the shared error contract", async () => {
  const routes = await authenticatedRoutes();
  assert.equal(routes.length, 23, routes.map((route) => route.relativePath).join("\n"));

  for (const route of routes) {
    const sourceFile = ts.createSourceFile(
      route.relativePath,
      route.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const directJsonErrorProperties = [];
    const handlersWithoutCatch = [];
    const handlersWithUnprotectedAuth = [];
    const handlersWithoutAuth = [];

    visit(sourceFile, (node) => {
      if (callName(node) === "Response.json") {
        const body = node.arguments[0];
        if (body && ts.isObjectLiteralExpression(body)) {
          for (const property of body.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ["error", "errorCode", "facts"].includes(propertyName(property))
            ) {
              directJsonErrorProperties.push(propertyName(property));
            }
          }
        }
      }

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(node.name.text) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        let hasCatch = false;
        const authCalls = [];
        if (node.body) {
          visit(node.body, (descendant) => {
            if (ts.isCatchClause(descendant)) hasCatch = true;
            if (callName(descendant) === "getApiActor") {
              authCalls.push(descendant);
            }
          });
        }
        if (!hasCatch) handlersWithoutCatch.push(node.name.text);
        if (authCalls.length === 0) handlersWithoutAuth.push(node.name.text);

        for (const authCall of authCalls) {
          let ancestor = authCall.parent;
          let protectedByCatch = false;
          while (ancestor && ancestor !== node) {
            if (
              ts.isTryStatement(ancestor) &&
              ancestor.catchClause &&
              authCall.getStart() >= ancestor.tryBlock.getStart() &&
              authCall.getEnd() <= ancestor.tryBlock.getEnd()
            ) {
              protectedByCatch = true;
              break;
            }
            ancestor = ancestor.parent;
          }
          if (!protectedByCatch) {
            handlersWithUnprotectedAuth.push(node.name.text);
          }
        }
      }
    });

    assert.deepEqual(
      directJsonErrorProperties,
      [],
      `${route.relativePath} bypasses apiError`,
    );
    assert.deepEqual(
      handlersWithoutCatch,
      [],
      `${route.relativePath} has a handler without a redacting catch path`,
    );
    assert.deepEqual(
      handlersWithoutAuth,
      [],
      `${route.relativePath} has an unauthenticated route handler`,
    );
    assert.deepEqual(
      handlersWithUnprotectedAuth,
      [],
      `${route.relativePath} resolves authentication before its catch boundary`,
    );
    assert.match(route.source, /unauthorizedResponse\(\)/);
  }
});

test("validation adapters retain locale-neutral actionable facts", async () => {
  const reasons = [
    "app/api/fitness/training-schedule/route.ts",
    "app/api/fitness/training-selections/route.ts",
    "app/api/fitness/training-template/route.ts",
    "app/api/nutrition/meals/route.ts",
    "app/api/nutrition/plans/route.ts",
    "app/api/nutrition/combos/route.ts",
  ];

  for (const relativePath of reasons) {
    const source = await readFile(`${repoRoot}/${relativePath}`, "utf8");
    assert.match(
      source,
      /reason:\s*error\.message/,
      `${relativePath} drops its validation reason`,
    );
    assert.doesNotMatch(
      source,
      /(?:message|reason):\s*["'`][^"'`]*[\u3400-\u9fff]/,
      `${relativePath} embeds localized validation prose`,
    );
  }

  const comboSource = await readFile(
    `${repoRoot}/app/api/nutrition/combos/route.ts`,
    "utf8",
  );
  assert.match(comboSource, /\{\s*foodId,\s*itemIndex:\s*index\s*\}/);

  const mealSource = await readFile(
    `${repoRoot}/app/api/nutrition/meals/route.ts`,
    "utf8",
  );
  assert.match(mealSource, /\{\s*comboItemIds:\s*unknownExcludedItemIds\s*\}/);
});

test("route error codes and compatibility strings satisfy the shared grammar", async () => {
  const routes = await authenticatedRoutes();
  let apiErrorCalls = 0;

  for (const route of routes) {
    const sourceFile = ts.createSourceFile(
      route.relativePath,
      route.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    visit(sourceFile, (node) => {
      if (callName(node) !== "apiError") return;
      apiErrorCalls += 1;
      const [code, , , compatibilityError] = node.arguments;
      if (code && ts.isStringLiteral(code)) {
        assert.match(code.text, API_ERROR_CODE_PATTERN, route.relativePath);
      }
      if (compatibilityError) {
        visit(compatibilityError, (value) => {
          if (ts.isStringLiteral(value)) {
            assert.match(value.text, /^[\x20-\x7e]+$/, route.relativePath);
          }
        });
      }
    });
  }

  assert.ok(apiErrorCalls >= 70, `found only ${apiErrorCalls} apiError calls`);
});

test("authentication and fallback failures also use the shared helper", async () => {
  const authSource = await readFile(`${repoRoot}/lib/api-auth.ts`, "utf8");
  const errorSource = await readFile(
    `${repoRoot}/lib/api-route-error.ts`,
    "utf8",
  );
  assert.match(authSource, /throw new ApiActorResolutionError\(error\)/);
  assert.match(errorSource, /apiError\(\s*"AUTHENTICATION_REQUIRED"/);
  assert.match(errorSource, /apiError\("INTERNAL_ERROR", 500\)/);
  assert.doesNotMatch(authSource, /Response\.json\(/);
  assert.doesNotMatch(errorSource, /Response\.json\(/);
  assert.doesNotMatch(authSource, /[\u3400-\u9fff]/);
  assert.doesNotMatch(errorSource, /[\u3400-\u9fff]/);
});
