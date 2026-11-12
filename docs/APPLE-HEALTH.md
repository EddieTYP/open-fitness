# Apple Health Active Energy sync

Open Fitness accepts Active Energy from an owner-controlled iPhone Shortcut.
This integration is optional and writes only to
`POST /api/nutrition/energy`. It does not read Apple Health directly.

## Security boundary

Set a random `FITNESS_HEALTH_SYNC_TOKEN` that is different from the owner
session secret and `FITNESS_API_TOKEN`. Keep `.env.local` owner-only and install
the token without printing it:

```sh
node scripts/install-health-sync-token.mjs .env.local
```

The bearer token is also stored in the Shortcut on the owner's iPhone. Do not
share or export that Shortcut with the live token. Use only a private HTTPS or
trusted-VPN origin; never send the token to a public or untrusted endpoint.

## Two modes

Both requests contain exactly `mode`, `localDate`, and `activeEnergyKcal`.
`localDate` must use `YYYY-MM-DD` in the profile's configured IANA timezone.

Intraday updates are provisional and are accepted only for the profile's
current date:

```json
{
  "mode": "intraday",
  "localDate": "2099-01-15",
  "activeEnergyKcal": 368.3
}
```

There is one stable intraday row per date. A changed total overwrites that row;
an unchanged total is a no-op. Increasing the automation frequency therefore
does not accumulate observation or audit rows.

Settlement is final and is accepted only for a completed date:

```json
{
  "mode": "settlement",
  "localDate": "2099-01-14",
  "activeEnergyKcal": 640
}
```

An exact settlement retry is a no-op. A corrected final total creates another
immutable observation, and the latest final value outranks the provisional row
for that date. Never send settlement for the current date and never retry a
`400` or `409` response with guessed fields.

## iPhone Shortcut

Create one reusable Shortcut that accepts a mode and date, then:

1. finds Apple Health **Active Energy** samples for that calendar day;
2. calculates their sum in kilocalories;
3. formats the day as `yyyy-MM-dd` in the same timezone as the Open Fitness
   profile; and
4. uses **Get Contents of URL** to POST the JSON body above to
   `https://your-private-origin/api/nutrition/energy`, with header
   `Authorization: Bearer <FITNESS_HEALTH_SYNC_TOKEN>`.

Create Personal Automations around that Shortcut:

- **Intraday:** run at whatever daytime intervals are useful, passing today's
  date and `intraday`. Each run sends the cumulative total so far.
- **Next-day settlement:** run once after midnight, passing yesterday's date and
  `settlement` so the completed Apple Health total becomes final.

Keep frequency on the iPhone rather than adding a scheduler to Open Fitness.
After setup, verify one disposable request in the Web UI before relying on the
automation.

## Read-only nutrition export API

`GET /api/nutrition/export` exports current consumed meal snapshots for a future
owner-controlled integration. This API does not write Apple Health, create an
iPhone Shortcut, or claim that a Health import/synchronization is installed.
The machine-readable contract is [nutrition-export.openapi.json](nutrition-export.openapi.json).

Configure two optional settings in the server's private environment and restart
it to enable this route (do not reuse any existing credential):

```dotenv
FITNESS_NUTRITION_EXPORT_TOKEN=<independent random read-only token>
FITNESS_NUTRITION_EXPORT_SOURCE_ID=<unique permanent nonsecret installation ID>
```

Generate a random token with `openssl rand -hex 32` and an installation ID with
`uuidgen`, privately at setup. Keep the source ID stable across token rotation,
restores and deployment updates; use a different source ID for an independent
installation. The source namespace hashes that ID with the profile ID. Never
put tokens into URLs or share them. Use a private HTTPS/trusted VPN origin.
The export token is accepted only on this GET route; existing agent/owner
authentication is also accepted here. Missing configuration disables export
with `500`. A token equal to a known agent, Health, session or password-hash
secret fails closed with `500` in shared API authentication, including write
routes, until independent tokens are restored. All export responses, including
errors, are `no-store`.

Example request: `GET /api/nutrition/export?startDate=2026-01-01&endDate=2026-01-31&limit=7`
with `Authorization: Bearer <FITNESS_NUTRITION_EXPORT_TOKEN>`. Alternatively use
`date=yesterday` for the daily export resolved by the server in the profile
timezone (independent of the phone timezone), `date=2026-01-01`, or omit dates
for all history through yesterday in the profile timezone. Ranges are inclusive and cannot include today/future dates. Supply
both range bounds or neither. Unknown/duplicate parameters are errors. Limits
are whole dates, default 31, maximum 90. Continue with only `cursor=<nextCursor>`
until it is null; the cursor is signed and fixes range, timezone, namespace and
limit. Token rotation invalidates cursors but preserves IDs/fingerprints.

Every date in the selected interval appears, even an empty date. `status:
"empty"`, no meals and unknown/null summaries authoritatively clear prior
exports for that date; absence from a page never means deletion. Voided content
and plans are excluded. Default history starts at the earliest stored meal date,
including voided records; no records returns yesterday as an empty date.
Meal revisions may move a meal to another localDate. Historical revisions
store nutrients, not former local dates. Retain the earliest date previously
synchronized and explicitly rescan the entire prior covered range to receive
clears after moves, including when the earliest meal moves later. The default
range alone cannot reconstruct former dates before its new earliest record.

Each page reads profile, meals, revisions and items in one read transaction.
Pages are not an immutable full-history snapshot: concurrent edits may change
already-read dates, so clients must rescan previously covered dates to reconcile
corrections. Stable date IDs and deterministic fingerprints allow replacement
and change detection; a timezone change invalidates cursors and changes day
fingerprints. Errors are failures, never empty clears. Meal IDs/revision numbers
and item snapshots preserve provenance. `eatenAt`/`timePrecision` are stored
values; date-only meals have no invented exact consumption timestamp.

Each of the ten nutrients (including trans fat) has `knownSum`, known/unknown
value counts and `unknown`, `partial` or `complete` status. A known meal total
is authoritative; an unknown meal total falls back to its item values, or one
unknown when no items exist. A partial sum is only the known subtotal; no known
values means null, while an explicit recorded zero stays zero. `complete`
describes recorded nutrient values, never proof the owner logged every meal.
Known subtotals use the existing nutrition precision of three decimal places.
