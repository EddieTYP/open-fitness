import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

test("public licensing metadata is explicit and internally consistent", () => {
  const license = read("LICENSE");
  const notice = read("NOTICE");
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));

  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.match(license, /13\. Remote Network Interaction/);
  assert.match(notice, /Open Fitness/);
  assert.match(notice, /Copyright \(C\) 2026 Edward Tsoi/);
  assert.match(notice, /AGPL-3\.0-or-later/);
  assert.match(notice, /THIRD_PARTY_NOTICES\.md/);
  assert.match(notice, /Unless otherwise noted/);
  assert.equal(packageJson.license, "AGPL-3.0-or-later");
  assert.equal(packageLock.packages[""].license, "AGPL-3.0-or-later");
  assert.equal(packageJson.private, true);
  assert.match(
    packageJson.scripts["db:backup:local"],
    /--env-file-if-exists=\.env\.local/,
  );
  assert.match(
    packageJson.scripts["db:migrate:local"],
    /--env-file-if-exists=\.env\.local/,
  );
  assert.match(
    read("components/profile/ProfileSettingsDialog.tsx"),
    /github\.com\/EddieTYP\/open-fitness[\s\S]*profile\.project\.license/,
  );
  assert.match(read("THIRD_PARTY_NOTICES.md"), /Geist[\s\S]*SIL Open Font License 1\.1/);
  assert.match(read("LICENSES/Geist-OFL-1.1.txt"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("public repository has a private security-reporting path and secret-free CI", () => {
  const security = read("SECURITY.md");
  const ci = read(".github/workflows/ci.yml");

  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /Do not include[\s\S]*database[\s\S]*token/i);
  assert.match(security, /one\s+owner/i);
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm audit --omit=dev --audit-level=high/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /npm run lint/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run build/);
  assert.doesNotMatch(ci, /FITNESS_|secrets\./);
  assert.doesNotMatch(ci, /uses:\s+actions\/(checkout|setup-node)@v\d/);
  assert.match(ci, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(ci, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(
    read("docs/operations/SELF-HOSTING.md"),
    /git clone --branch v0\.1\.0 --depth 1[\s\S]*does not install or configure that private-access layer/i,
  );
});

test("optional-agent guides state the provider privacy boundary", () => {
  for (const path of [
    "docs/ONBOARDING.md",
    "integrations/hermes/README.md",
  ]) {
    const guide = read(path).replace(/\s+/g, " ");
    assert.match(guide, /health records, photos, and prompts/i);
    assert.match(guide, /selected\s+chat\/model provider/i);
    assert.match(guide, /data-retention, model-training, and privacy terms/i);
    assert.match(guide, /informed consent/i);
    assert.match(guide, /least data needed/i);
    assert.match(guide, /disposable UAT data/i);
    assert.match(guide, /cannot control provider data[\s\S]*after transmission/i);
  }
});

test("new owners receive a generic profile-timezone Apple Health contract", () => {
  const onboarding = read("docs/ONBOARDING.md");
  const appleHealth = read("docs/APPLE-HEALTH.md");

  assert.match(onboarding, /\[intraday overwrite and next-day settlement contract\]\(APPLE-HEALTH\.md\)/);
  assert.doesNotMatch(onboarding, /LOCAL-HOSTING\.md#apple-health/i);
  assert.match(appleHealth, /profile's configured IANA timezone/i);
  assert.match(appleHealth, /one stable intraday row per date/i);
  assert.match(appleHealth, /exact settlement retry is a no-op/i);
  assert.match(appleHealth, /does not read Apple Health directly/i);
  assert.doesNotMatch(
    appleHealth,
    /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?:\/|\\)/,
  );
  assert.doesNotMatch(appleHealth, /\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/);
});

test("public contract fixtures are synthetic and future-dated", () => {
  const fixturePaths = [
    "tests/agent-integration-contract.test.mjs",
    "tests/log-ui-contract.test.mjs",
  ];
  for (const path of fixturePaths) {
    const fixture = read(path);
    assert.doesNotMatch(
      fixture,
      /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?:\/|\\)/,
      `${path} contains a literal home directory`,
    );
    assert.match(
      fixture,
      /Synthetic/i,
      `${path} must label its sample data synthetic`,
    );
  }

  const agentContract = read(fixturePaths[0]).replaceAll(
    'protocolVersion: "2024-11-05"',
    "",
  );
  assert.doesNotMatch(
    agentContract,
    /"(?:19\d{2}|20[0-8]\d)-\d{2}-\d{2}/,
    "public health fixtures must use clearly synthetic 2090+ dates",
  );
  assert.match(agentContract, /"2099-\d{2}-\d{2}/);
});

test("README editions cover English, zh-TW, and zh-CN while the product targets four locales", () => {
  const readme = read("README.md");
  const readmeTw = read("README_zh-TW.md");
  const readmeCn = read("README_zh-CN.md");
  const i18n = read("docs/I18N.md");

  for (const edition of [readme, readmeTw, readmeCn]) {
    assert.match(edition, /^# Open Fitness/m);
    assert.match(edition, /AGPL-3\.0-or-later/);
    assert.match(edition, /docs\/I18N\.md/);
    assert.doesNotMatch(edition, /README_zh-HK\.md/);
  }

  assert.match(readme, /README_zh-TW\.md/);
  assert.match(readme, /README_zh-CN\.md/);
  assert.match(readme, /product and Web UI target/);
  assert.match(readme, /Web UI are available in all four languages/i);
  assert.match(readme, /generated training\s+plans, session reviews, progress commentary, and log labels/i);
  assert.match(readme, /owner-specified wording, brand\/product names/i);
  assert.match(readme, /agent composes for storage[\s\S]*profile's preferred locale/i);
  assert.match(readme, /never retro-translates saved content/i);
  assert.equal(existsSync(join(root, "README_zh-TW.md")), true);
  assert.equal(existsSync(join(root, "README_zh-CN.md")), true);
  assert.equal(existsSync(join(root, "README_zh-HK.md")), false);

  assert.match(i18n, /locale-neutral message descriptors/);
  assert.match(i18n, /Stored source-authored content\s+remains verbatim/);
  assert.match(i18n, /English, `zh-TW`, and `zh-CN`/);
  assert.match(i18n, /no separate `zh-HK` README/);
  assert.match(read("CONTRIBUTING.md"), /external code contributions are temporarily closed/i);
});

test("product contract keeps agents neutral and venue optional", () => {
  const vision = read("docs/PRODUCT-VISION.md");
  const agents = read("AGENTS.md");
  const workflow = read("agent-plugin/skills/open-fitness/SKILL.md");
  const workflowContract = read(
    "agent-plugin/skills/open-fitness/references/contract.md",
  );
  const mcp = read("agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs");

  assert.match(vision, /owner-selected agent/);
  assert.match(vision, /Venue is opportunistic metadata, never a required workout choice/);
  assert.match(vision, /owner may configure a default venue in the selected agent/);
  assert.match(vision, /supplies a venue, it remains unknown/);
  assert.match(vision, /request-scoped planning context/);
  assert.match(
    vision,
    /Legacy recovery-completion prose is read only for legacy text cycles/,
  );
  assert.match(vision, /does not silently reduce an unrelated phase/);
  assert.match(agents, /do not add mandatory venue/);
  assert.match(agents, /Locale and timezone are independent/);
  assert.match(workflow, /profile-local date range/);
  assert.match(workflowContract, /profile timezone returned by the current\s+snapshot/);
  assert.match(mcp, /Profile-local date YYYY-MM-DD/);
  for (const source of [workflow, workflowContract, mcp]) {
    assert.doesNotMatch(source, /Hong Kong date|Hong Kong time/);
  }
});
