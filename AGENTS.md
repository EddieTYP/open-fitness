# Open Fitness change contract

This application and its API-backed local SQLite database are the active
owner profile's canonical fitness and nutrition record. Historical imports are
source evidence only; never treat them as the live record. Use the
API for normal reads and writes, and do not inspect or mutate the live SQLite
file directly unless the task explicitly concerns migration or recovery.

Treat record-writing behavior as a product workflow, not only an API
implementation detail.

For every code change, inspect all affected layers before declaring it done:

1. user workflow and mobile UI;
2. API request, response, error, idempotency, and read-back behavior;
3. SQLite schema, migration, historical backfill, backup, and rollback/recovery;
4. dashboard, analysis, views, revisions, and cache refresh behavior;
5. the active `agent-plugin/skills/open-fitness` skill/reference contract;
6. tests for the changed behavior and its failure path.

If an API field, endpoint, timestamp rule, mutation state, or metric meaning
changes, update its machine-readable route contract and the matching agent
workflow in the same task. If the workflow does not need a change, record the
reason in the handoff. Metric-definition changes must bump the metric-contract
version.

Record mutations must be deterministic and recoverable:

- never probe the live runtime to discover a payload;
- reject unknown fields instead of ignoring aliases;
- canonicalize timestamps before uniqueness checks;
- require idempotency for writes;
- write atomically, then read back and compare;
- stop on `400` or `409`; do not retry with guessed aliases or equivalent
  timezone spellings;
- use the entity's revision/soft-void path for invalid records; do not hide a
  bad row with a note or unrelated correction;
- exclude voided data from all default user-facing queries and derived views.

Agent memory is not a second record store. An optional agent or adapter may
retain only durable cross-session facts that are not already represented by the
Fitness API, such as the owner's stable preferences, goals, injuries,
constraints, and communication habits. Never copy meals, workouts,
measurements, calculations, temporary plans, or inferred diagnoses into agent
memory; replace or remove stored facts when the owner corrects them.

Keep the core API and MCP workflow agent-agnostic. Adapter-specific transport,
tool naming, prompts, and setup belong under `integrations/<adapter>/` and must
not become a core runtime dependency.

Protect the product boundary in `docs/PRODUCT-VISION.md`:

- structured repeatable data belongs to integrations;
- high-entropy text/image interpretation may belong to an owner-selected agent;
- direct Web UI actions should exist only when they are faster or clearer than
  using an integration or agent;
- do not add mandatory venue, source-app, or agent-selection steps to the daily
  workflow;
- venue is optional structured metadata resolved from the current request,
  source data, or an owner-configured default; without any of those, absence is
  unknown and must not be inferred from localized prose;
- prefer importing from a specialist app over rebuilding its complete tracking
  workflow without evidence that the duplication helps users.

Localization must follow `docs/I18N.md`. Locale and timezone are independent.
Never derive domain behaviour from displayed words, persist localized labels as
semantic enums, or retro-translate stored owner/source content. New user-facing
text composed by an agent for storage uses the profile `preferredLocale`; exact
owner wording, brands, product names, and importer evidence remain verbatim.
New API errors need stable codes, and the same fixture must produce the same
domain decision in `zh-HK`, `zh-TW`, `zh-CN`, and `en`.

Licensing changes must follow `docs/LICENSING.md`. Do not remove or modify the
AGPL license text, imply that user health data is licensed as application code,
or merge substantive external contributions before the maintainer has published
the contribution terms needed for the intended dual-license model.

Before checkpointing, run the relevant focused tests, the full test suite,
lint, and the verified build. Migration tests must run all migrations from an
empty database and assert foreign-key and integrity checks.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
