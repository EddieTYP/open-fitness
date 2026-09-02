# Local SQLite driver decision

## Decision

Task 3 selects `@libsql/client` v`0.17.4` as the local SQLite runtime adapter for native Node/Next routes.

## Why this driver

- The existing data and drizzle schema are already standard SQLite/SQL with no Cloudflare-only SQL surface needed for local runtime reads and writes.
- `@libsql/client` provides a stable Node-compatible adapter path for `drizzle-orm/libsql` without introducing a custom `better-sqlite3` shim.
- The direct client is compatible with the repository’s Drizzle SQL layer and supports `execute`/`batch` operations used by current routes.
- Native Node/Next is the canonical runtime. The retired Cloudflare worker/build surface is recoverable from Git history rather than carried in current releases.

## Fail-closed path and lifecycle contract

- `FITNESS_SQLITE_PATH` must be set, trimmed, absolute, existing, regular, non-empty, and pass SQLite integrity validation.
- Before WAL is enabled, the preflight requires the complete current Edward Fitness table inventory, key column sentinels across profile/audit/workout/nutrition/schema metadata, and exactly one canonical `schema_metadata` identity row (`Edward Fitness Master`, canonical master, Hong Kong timezone, valid version). A generic SQLite database with a numeric marker table is rejected unchanged.
- The local client is created only once per process via a module singleton (`getLocalDb`), and path changes while open are rejected.
- `closeLocalDbForTests()` closes the underlying client, clears singleton state, and allows reopening with a different path.
- A synchronous standard-SQLite preflight runs `integrity_check`, validates the unique `schema_metadata.schema_version`, rejects empty, duplicate, malformed, negative, unsafe-integer, or wrong-identity metadata, records that version, and only then enables and verifies WAL.
- Authenticated admin status exposes only adapter, WAL, busy timeout, and schema version; it never returns the database path or credentials.
- The libSQL client receives a 5000 ms busy timeout; focused tests query that actual connection and prove its foreign-key enforcement.
- Closing the native libSQL client makes old Drizzle handles reject with a `CLIENT_CLOSED` cause.
- No schema migration is executed in Task 3 local adapter initialization.

## Known runtime note

The synchronous preflight uses Node 22's built-in `node:sqlite`, which emits an experimental-feature warning on the currently tested runtime. The warning does not change query behavior and is accepted for this migration stage; deployment must keep the tested Node 22 line until a later compatibility review replaces or revalidates the preflight.

The libSQL production path reaches `ws` through `@libsql/isomorphic-ws`. A package-scoped npm override constrains that path to patched `ws@8.21.2`; no separate root `ws` package is installed.

## Rollback and interoperability evidence

- The contract tests use a synthetic disposable fixture created via `node:sqlite` and validate:
  - WAL mode persists for the same file (`PRAGMA journal_mode` via `node:sqlite`).
  - Foreign key constraints are enforced through libSQL-backed writes.
  - Batched inserts are atomic (`UNIQUE` constraint rollback visible through `node:sqlite`).
- These checks provide practical rollback/readback interoperability with standard SQLite tooling for the Task 3 path.
