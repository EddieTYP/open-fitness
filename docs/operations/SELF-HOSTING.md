# Generic self-hosting

This is the supported clean-start path for a new single-owner installation. It
does not need Hermes or a bundled service manager. The application binds to
loopback; expose it only through a private HTTPS reverse proxy or VPN you
control.

A fresh database defaults to English and `UTC`. Set the owner's actual IANA
timezone and preferred locale during initialization or first-run setup. The
profile timezone controls the meaning of “today” and the local date stored for
new records; changing it later does not rewrite historical local dates.

## 1. Install

Requires Node.js 22.18 or newer.

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/EddieTYP/open-fitness.git
cd open-fitness
npm ci
```

Use the signed-off tag named by the current GitHub release; `v0.1.0` is the
public-beta tag. Do not install a floating default branch for an owner database.

Keep application data outside the repository:

```sh
mkdir -m 700 "$HOME/.open-fitness"
mkdir -m 700 "$HOME/.open-fitness/backups"
```

The simple clone above is enough for development and manual rebuilds. The
transactional upgrade command described below uses this explicit release
layout instead:

```text
$HOME/.open-fitness/app/
├── current -> releases/<40-character-git-commit>
└── releases/
    └── <40-character-git-commit>/
```

Both `app/` and `app/releases/` must be real, owner-controlled directories that
are not writable by group or other users. `current` is the only required
symlink. The release directory name is the exact lowercase commit ID.

## 2. Create an empty owner database

Choose the initial goal and slash-separated training cycle explicitly. The
command creates a new `0600` SQLite file, applies every migration, writes one
minimal owner profile, and leaves all health, workout, and nutrition history
empty. It refuses to overwrite an existing path.

```sh
npm run db:init:local -- \
  --path "$HOME/.open-fitness/fitness.sqlite" \
  --goal "General fitness" \
  --cycle "Leg / Push / Pull / Recovery" \
  --timezone "Europe/London" \
  --locale "en"
```

The cycle and timezone above are only examples; replace them before
initialization. Supported locales are `en`, `zh-HK`, `zh-TW`, and `zh-CN`.
Optional flags are `--profile-id`, `--height-cm`, and `--owner-email`; omitted
timezone and locale values default to `UTC` and `en`.

## 3. Configure secrets

Copy the template and edit every placeholder:

```sh
cp .env.example .env.local
chmod 600 .env.local
```

Set `FITNESS_SQLITE_PATH` and `FITNESS_BACKUP_DIR` to the two absolute paths
created above. Generate independent random values for the session secret and
each enabled automation boundary, for example with `openssl rand -base64 48`.

Generate the owner password hash without placing the password in shell history:

```sh
read -s OWNER_PASSWORD
OWNER_HASH=$(printf '%s\n' "$OWNER_PASSWORD" | npm run --silent auth:hash-owner)
unset OWNER_PASSWORD
printf '%s\n' "$OWNER_HASH" | sed 's/[$]/\\$/g'
```

Choose a unique owner password containing 12 to 1024 Unicode characters; a
password-manager-generated value or long passphrase is recommended. Hash
creation rejects shorter passwords. Verification still accepts an existing
hash made from a shorter password so an upgrade cannot lock out its owner, but
that compatibility is not an endorsement: generate and deploy a new strong
password hash promptly. Changing `FITNESS_OWNER_PASSWORD_HASH` invalidates
existing owner sessions.

Paste the final escaped output into `FITNESS_OWNER_PASSWORD_HASH`. The
backslashes are required because Next.js expands unescaped dollar signs in
`.env.local`; the application receives the original scrypt value.

Set `FITNESS_RELEASE_ID` to the exact 40-character commit used for the build:

```sh
git rev-parse HEAD
```

If two Open Fitness instances use the same hostname on different ports, give
each instance a distinct `FITNESS_OWNER_SESSION_COOKIE_NAME`. Browser cookies
are scoped by hostname rather than port, so this prevents a production Secure
cookie from blocking an HTTP development login. Use a short identifier made
only from letters, digits, `_`, or `-`; for example:

```sh
FITNESS_OWNER_SESSION_COOKIE_NAME=open_fitness_isolated_session
```

The readiness endpoint deliberately stays unavailable when this identity is
missing or malformed.

For local development, keep
`FITNESS_PUBLIC_ORIGIN=http://127.0.0.1:3000`. For production, set it to the
exact private HTTPS origin users will open.

## 4. Run

Development:

```sh
npm run dev
```

Production behind an operator-supplied private HTTPS proxy or VPN:

```sh
npm run build
npm start
```

The public beta does not install or configure that private-access layer. Its
portable support boundary is the loopback application; the operator owns the
proxy/VPN and persistent service configuration.

Open the configured origin and sign in with the owner password. `npm start`
loads `.env.local` when present and binds to `127.0.0.1`; set `PORT` if port
3000 is unavailable.

Owner login has a bounded, process-local failure limit for this single-process
deployment: after five failed checks in a rolling 15-minute window, later
checks receive `429` and `Retry-After`. A successful login clears that client's
failures; a process restart clears all failure state. The checked-in private
proxy strips incoming forwarding headers and supplies one literal client
address. The app uses it only when
`X-Forwarded-Proto` is `https` and `X-Forwarded-Host` exactly matches `Host`;
missing, chained, or malformed values share a direct-client fallback bucket.
The map is capped at 256 states and excess client addresses share its bounded
overflow bucket. Do not put an untrusted proxy in front of the loopback app or
run multiple app processes expecting this limiter to coordinate between them.

On a clean database, the first signed-in page opens profile setup. Confirm the
display name, goal, and ordered training/recovery phases before recording data.
The Web UI can then record workouts, body measurements, recovery notes, and
one-off meals directly; an agent is optional.

## 5. Maintain the database

Run standalone database commands with Node's environment-file support so values
containing spaces do not have to be interpreted by the shell:

```sh
node --env-file=.env.local scripts/local-db-migrate.mjs --check
node --env-file=.env.local scripts/backup-sqlite.mjs
```

Read [BACKUP-RESTORE.md](BACKUP-RESTORE.md) before applying a migration or
restoring a backup. Never test a mutation against a live database.

## 6. Upgrade an existing self-host safely

The public-beta upgrade path expects a service manager that can synchronously
stop and start the loopback application. Prepare a new checkout under
`<app-root>/releases/<commit>` and run `npm ci` there. Do not change `current`
yet. The activation command itself runs, in order, the full test suite,
typecheck, lint, and production build before it opens the live database. Those
preflight child processes do not receive `FITNESS_*` values or `NODE_ENV`, so a
candidate test cannot inherit the live database path or runtime secrets.

Describe the two service-manager actions as JSON argv arrays, not shell text:

```json
{
  "stop": ["/absolute/path/to/service-control", "stop", "open-fitness"],
  "start": ["/absolute/path/to/service-control", "start", "open-fitness", "{releaseId}"]
}
```

Save that file outside the repository with mode `0600`. The optional exact
`{releaseId}` argument is replaced without a shell; a start wrapper can use it
as `FITNESS_RELEASE_ID`. A service manager that derives the ID from the
`current` symlink can omit the placeholder. In either case, the started process
must report that exact 40-character ID from its loopback `/api/health` response.

Run the candidate's activation script with explicit paths. The database and
backup directory still come only from `FITNESS_SQLITE_PATH` and
`FITNESS_BACKUP_DIR` (shown here loaded from an owner-only external environment
file):

```sh
node --env-file="$HOME/.open-fitness/config/runtime.env" \
  "$HOME/.open-fitness/app/releases/$NEW_RELEASE/scripts/activate-self-host-release.mjs" \
  --app-root "$HOME/.open-fitness/app" \
  --release "$NEW_RELEASE" \
  --adapter "$HOME/.open-fitness/config/activation.json" \
  --health-url 'http://127.0.0.1:3000/api/health'
```

`NEW_RELEASE` must already be the exact 40-character directory name. If the
environment is already loaded, the equivalent package entrypoint must still be
selected from that candidate checkout:

```sh
npm --prefix "$HOME/.open-fitness/app/releases/$NEW_RELEASE" run self-host:activate -- \
  --app-root "$HOME/.open-fitness/app" \
  --release "$NEW_RELEASE" \
  --adapter "$HOME/.open-fitness/config/activation.json" \
  --health-url 'http://127.0.0.1:3000/api/health'
```

Do not run the package entrypoint from `current` or another checkout. The
activation command attests that its running script and relative migration
journal belong to the named candidate release and rejects an old checkout.

After preflight passes, activation stops the service and proves the main
database and its WAL/SHM/journal files have no open handles. Only then does it
create and verify the rollback snapshot beside the live database, so a write
committed immediately before the stop is preserved. It applies committed
migrations, atomically switches `current`, starts, and accepts only the exact
candidate release ID and migration-result schema version. A failure restores
the previous code link and compares the stopped snapshot with the live database
before deciding whether database replacement is necessary. An unchanged
no-migration database stays in place; an actually changed database is restored,
and rollback health must report the stopped snapshot's exact schema version. If
stopped state or rollback cannot be proved, it fails closed and does not restart
a possibly mismatched code/database pair.

Keep the reported backup, manifest, restore candidate, and verification report
through the rollback window. The lock is intentionally fail-closed: an
interrupted process can leave `.self-host-activate.lock`; remove it only after
confirming no activation and no service-control action is still running.

### Public-beta platform ceiling

This is an orchestration contract, not a service installer. The operator still
supplies the service-manager adapter and stages the release checkout. The
current implementation requires a POSIX-style filesystem with atomic symlink
rename, hard links, directory `fsync`, and `/usr/sbin/lsof`; Windows and hosts
without that `lsof` path are not supported yet. Release-directory naming is an
operator trust boundary—the command validates the 40-character name, attests
that it is running the candidate's script and migration journal, and runs that
candidate's checks/build, but does not independently attest a Git archive or
download releases. Off-site encryption and retention also remain separate
operator responsibilities.

## Optional agent

Open Fitness runs without an agent. To connect one, install the Agent Plugins v1
package under `agent-plugin/`.
Hermes-specific portable-install notes are under `integrations/hermes/`. The
end-to-end sequence, private environment requirements, and disposable
acceptance check are in [new owner onboarding](../ONBOARDING.md).
