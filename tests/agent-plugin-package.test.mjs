import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(root, "agent-plugin");
const read = (path) => readFileSync(join(root, path), "utf8");
const readPlugin = (path) => readFileSync(join(pluginRoot, path), "utf8");

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

test("minimal package manifest targets the portable Agent Plugins v1 contract", () => {
  const manifest = JSON.parse(readPlugin("plugin.json"));
  const packageJson = JSON.parse(read("package.json"));
  const allowedFields = [
    "$schema",
    "author",
    "description",
    "extensions",
    "homepage",
    "keywords",
    "license",
    "name",
    "repository",
    "version",
  ];

  assert.equal(manifest.$schema, PLUGIN_SCHEMA);
  assert.equal(manifest.name, "open-fitness");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.license, "AGPL-3.0-or-later");
  assert.deepEqual(
    Object.keys(manifest).filter((field) => !allowedFields.includes(field)),
    [],
  );
  assert.equal(existsSync(join(pluginRoot, ".codex-plugin", "plugin.json")), false);
});

test("portable package contains no links, private paths, or secret values", () => {
  const packagePaths = ["plugin.json", "mcp.json", "skills/open-fitness"];
  const files = [];

  assert.deepEqual(readdirSync(pluginRoot).sort(), [
    "mcp.json",
    "plugin.json",
    "skills",
  ]);

  function visit(path) {
    const absolutePath = join(pluginRoot, path);
    const stat = lstatSync(absolutePath);
    assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symlink`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) {
        visit(join(path, entry));
      }
      return;
    }
    files.push(path);
  }

  for (const path of packagePaths) {
    visit(path);
  }

  const contents = files.map((path) => readPlugin(path)).join("\n");
  assert.doesNotMatch(contents, /(?:\/Users\/|[A-Za-z]:\\Users\\)/);
  assert.doesNotMatch(contents, /(?:gho_|sk-[A-Za-z0-9]|xox[baprs]-)[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(contents, /FITNESS_API_TOKEN\s*[:=]\s*(?![A-Z_]*\b)["']?[^\s"']+/);
});

test("minimal MCP configuration uses one portable stdio server without secrets", () => {
  const config = JSON.parse(readPlugin("mcp.json"));

  assert.deepEqual(Object.keys(config).sort(), ["$schema", "mcpServers"]);
  assert.equal(config.$schema, MCP_SCHEMA);
  assert.deepEqual(Object.keys(config.mcpServers), ["of"]);
  assert.deepEqual(config.mcpServers.of, {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/skills/open-fitness/scripts/fitness-mcp.mjs"],
    cwd: "${PLUGIN_ROOT}",
  });
  assert.equal(
    existsSync(join(pluginRoot, "skills/open-fitness/scripts/fitness-mcp.mjs")),
    true,
  );

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /FITNESS_API_TOKEN|FITNESS_API_BASE_URL/);
  assert.doesNotMatch(serialized, /(?:\/Users\/|[A-Za-z]:\\Users\\)/);
});

test("canonical Open Fitness skill uses standard Agent Skills frontmatter", () => {
  const skill = readPlugin("skills/open-fitness/SKILL.md");
  const contract = readPlugin("skills/open-fitness/references/contract.md");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];

  assert.ok(frontmatter, "SKILL.md must begin with YAML frontmatter");
  const fields = frontmatter
    .split("\n")
    .map((line) => line.match(/^([a-z][a-z0-9-]*):/)?.[1])
    .filter(Boolean);
  assert.deepEqual(fields, ["name", "description"]);
  assert.match(frontmatter, /^name: open-fitness$/m);
  assert.match(frontmatter, /^description: \S.+$/m);
  assert.doesNotMatch(frontmatter, /required_environment_variables/);
  assert.match(skill, /^# Open Fitness$/m);
  assert.ok(skill.split("\n").length < 500);
  assert.match(skill, /\(references\/contract\.md\)/);
  assert.match(skill, /\(references\/evidence\.md\)/);
  assert.match(contract, /Version `6`/);
  assert.match(
    contract,
    /latestStrength[\s\S]*aggregate[\s\S]*latestReview\.segments/,
  );

  const activeGuidance = `${skill}\n${contract}`;
  for (const outcome of [
    "validated",
    "succeeded",
    "conflict",
    "failed",
    "uncertain",
  ]) {
    assert.match(activeGuidance, new RegExp(`\\b${outcome}\\b`));
  }
  assert.match(activeGuidance, /performs one mutation and its\s+verification/i);
  assert.match(activeGuidance, /steer received before dispatch/i);
  assert.match(activeGuidance, /after dispatch[\s\S]*same entity/i);
  assert.doesNotMatch(
    activeGuidance,
    /mutation_superseded_by_steer|\bbridge\b|\bparent\b|\bworker\b/i,
  );

  for (const path of [
    "skills/open-fitness/references/contract.md",
    "skills/open-fitness/references/evidence.md",
    "skills/open-fitness/scripts/fitness-mcp.mjs",
  ]) {
    assert.equal(existsSync(join(pluginRoot, path)), true, `${path} must exist`);
  }
});

test("legacy workflow and client-specific profile artifacts are not packaged", () => {
  for (const path of [
    "plugin.json",
    "mcp.json",
    "skills/open-fitness",
    "workflows/analyze-fitness/SKILL.md",
    "workflows/analyze-fitness/references/contract.md",
    "workflows/analyze-fitness/references/evidence.md",
    "workflows/analyze-fitness/scripts/fitness-mcp.mjs",
    "integrations/mcp/README.md",
    "integrations/mcp/stdio-config.json.example",
    "integrations/hermes/fitness-profile/SOUL.md",
    "integrations/hermes/fitness-profile/env.example",
    "integrations/hermes/fitness-profile/tooling.yaml.example",
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${path} must be absent`);
  }
});

test("Hermes documentation is a thin portable-install guide", () => {
  const guide = read("integrations/hermes/README.md");

  assert.ok(guide.split("\n").length < 60);
  assert.match(guide, /portable Agent Plugins v1 package/i);
  assert.match(
    guide,
    /hermes plugins install EddieTYP\/open-fitness#agent-plugin --no-enable/,
  );
  assert.match(guide, /hermes plugins enable open-fitness/);
  assert.match(guide, /FITNESS_API_BASE_URL/);
  assert.match(guide, /FITNESS_API_TOKEN/);
  assert.match(guide, /private environment or secret mechanism/);
  assert.doesNotMatch(guide, /(?:\/Users\/|[A-Za-z]:\\Users\\)/);
  assert.doesNotMatch(guide, /SOUL\.md|tooling\.yaml|fitness-profile/);
});
