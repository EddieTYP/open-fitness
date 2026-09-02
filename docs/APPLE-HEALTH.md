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
