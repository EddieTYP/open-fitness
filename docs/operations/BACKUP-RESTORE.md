# Open Fitness SQLite Backup and Restore

## Scope

This runbook covers backup, migration, and restore for the private native SQLite runtime.

The application must continue to receive one explicit, absolute `FITNESS_SQLITE_PATH`. Backup and migration tools never guess a database, create a replacement database, or fall back to a repository or `/tmp` path.

Example generic locations (choose your own owner-only absolute paths):

- Database: `$HOME/.open-fitness/data/fitness.sqlite`
- Backups: `$HOME/.open-fitness/backups/`

Staging must use its own database and backup directories. Do not share mutable
storage between staging and the self-host service.

## Filesystem boundary

Create runtime directories separately from these scripts and restrict them to the service owner:

- directories: mode `0700`;
- SQLite databases, backup files, manifests, restored drills, and reports: mode `0600`;
- no symlink may be supplied as the configured database, backup directory, backup, or manifest;
- every configured path must be absolute;
- every output must be new. Existing backup, restore, manifest, and report paths are never overwritten.

The CLI wrappers set `umask 077`, and generated backup, manifest, restore, and report files are explicitly restricted to `0600`. Do not store credentials in filenames, labels, manifests, or reports.

## WAL-safe online backup

Do not use `cp`, Finder copy, `rsync`, or a main-file-only hash as a live backup of a database in WAL mode. Committed rows may still exist only in `fitness.sqlite-wal`.

The backup command uses Node's SQLite online backup API, reads a consistent database snapshot, and writes a closed standalone SQLite file:

```bash
export FITNESS_SQLITE_PATH='/absolute/path/to/fitness.sqlite'
export FITNESS_BACKUP_DIR='/absolute/path/to/existing/backups'
npm run db:backup:local
```

The command creates two new files:

- `edward-fitness-<UTC timestamp>-v<schema>-manual.sqlite`
- the matching `.manifest.json`

The manifest contains no source path or health rows. It records:

- format and application version;
- UTC timestamp;
- backup filename, byte size, and SHA-256;
- canonical database identity and schema version;
- `integrity_check` result;
- foreign-key violation count;
- row counts for every canonical application table;
- bounded representative-query results.

A failed backup does not leave a trusted manifest. Backup and restore payloads are first built under a private temporary directory and published with an atomic no-clobber hard link; JSON evidence is written through a reserved descriptor whose inode is rechecked. A competing file or symlink causes failure without following or overwriting it. Treat any partial file without a valid matching manifest as unusable.

## Versioned local migrations

The local migration runner uses only the committed Drizzle journal, SQL files, and snapshots under `drizzle/`. It also constructs each journal version in a disposable database and compares a canonical schema identity covering `sqlite_master` tables/indexes/views/triggers, table metadata, foreign keys, implicit and explicit indexes, defaults, primary keys, uniqueness, checks, and SQL definitions. `schema_metadata.schema_version` is the current applied journal index. Historical migration SQL is not rewritten.

First perform a read-only check:

```bash
export FITNESS_SQLITE_PATH='/absolute/path/to/fitness.sqlite'
npm run db:migrate:local -- --check
```

The check fails closed when:

- the database identity or exact declared schema does not match;
- integrity or foreign keys fail;
- the schema version is absent from the committed journal;
- the database is newer than the running application build.

Apply pending migrations only during an explicit maintenance action:

```bash
export FITNESS_SQLITE_PATH='/absolute/path/to/fitness.sqlite'
export FITNESS_BACKUP_DIR='/absolute/path/to/existing/backups'
npm run db:migrate:local -- --apply
```

Before any pending SQL runs, the tool creates and validates a WAL-safe `pre-migration-v<from>-to-v<target>` backup. Migration statements and the metadata version advance run inside one `BEGIN IMMEDIATE` transaction with post-migration snapshot, integrity, and foreign-key checks. A failed transaction rolls back; the pre-migration backup remains available. A database already at the target is a read-only no-op and creates no backup.

Stop the application service before a real migration. The transaction lock is a final safety guard, not a substitute for a maintenance window.
After the migration, start a fresh application process. In development, do not
rely on hot reload after changing the SQLite schema; restart `next dev` so no
long-lived module or database connection retains the pre-migration shape.

## Backup restore drill

Verification always restores to a fresh path; it never replaces the configured database:

```bash
npm run db:verify-backup -- \
  '/absolute/path/to/backup.sqlite' \
  '/absolute/path/to/backup.manifest.json' \
  '/absolute/new/path/restore-drill.sqlite' \
  '/absolute/new/path/restore-report.json'
```

The verifier performs this sequence:

1. require regular, non-zero backup and manifest files;
2. validate the complete manifest schema, exact keys/types, canonical timestamp, application identity, safe matching filename, and bounded size;
3. compare backup byte size and SHA-256 with the manifest;
4. verify canonical identity, schema version, integrity, foreign keys, row counts, and representative queries;
5. restore through SQLite's backup API to a new file;
6. repeat the same checks against the restored file;
7. emit a non-secret verification report with `passed: true`.

Any hash, size, identity, integrity, foreign-key, count, or representative-query mismatch fails closed before a success report is written. A failed restore drill is not a usable restore candidate.

## Stopped self-host restore

The generic restore entrypoint never guesses an Edward path or accepts an
`--active` override. It replaces only the explicit absolute
`FITNESS_SQLITE_PATH` inherited by the process. First stop the service through
its service manager and produce the candidate/report pair with the verification
command above. The candidate and the new rollback path must be beside the
active database so the rollback hard link and final rename stay on one
filesystem. Also create an owner-only `0600` JSON argv file whose command exits
zero only while the intended service is stopped; for example, a systemd host
can wrap `systemctl --user is-active` with the service-specific inactive-state
policy:

```json
["/absolute/path/to/check-open-fitness-stopped"]
```

Then run:

```bash
export FITNESS_SQLITE_PATH='/absolute/path/to/fitness.sqlite'
npm run db:restore:stopped -- \
  --candidate '/absolute/path/to/verified-candidate.sqlite' \
  --report '/absolute/path/to/verified-report.json' \
  --rollback '/absolute/path/to/new-fitness.sqlite.rollback' \
  --stopped-check '/absolute/path/to/stopped-check.json'
```

The command repeatedly executes the stopped-state argv with `shell: false` and
uses `lsof` to prove there are no handles on the main database, WAL, SHM, or
rollback-journal path: before validation, before WAL checkpoint, before
creating the rollback hard link, and immediately before the atomic rename. An
unavailable or non-zero stopped check, an unavailable handle probe, a reopened
handle, an unexpected sidecar, a changed candidate/report, a cross-filesystem
candidate, or an existing rollback path fails closed. On success, keep the
rollback file until the restarted service passes health and application smoke
tests.

This command does not stop or start a service; it only re-proves the explicit
service-manager state. For upgrades that couple the stop, migrations, code
switch, health acceptance, and database rollback, use the transactional path in
[Generic self-hosting](SELF-HOSTING.md#6-upgrade-an-existing-self-host-safely).

## Retention and off-site protection

Until real operating history supports another policy, retain at least:

- every pre-migration backup;
- 7 daily backups;
- 8 weekly backups;
- 12 monthly backups;
- the last known-good pre-activation backup for the full rollback window.

Retention deletion must be a deliberate, separately reviewed operation; these scripts do not auto-delete backups.

The Mac and local backup volume should remain protected by FileVault. For off-site storage, wrap the closed `.sqlite` and matching manifest together in an authenticated encrypted archive or an encrypted backup system such as age/restic. Keep keys in Keychain or the backup system's secret store. Never place passphrases, repository tokens, cloud credentials, database contents, or encryption keys in Git, shell history, manifests, reports, or this runbook.

Periodically restore an off-site copy into a disposable local directory and run the same verifier. An untested encrypted upload is not a verified backup.
