# New owner onboarding

This guide recreates the supported Open Fitness workflow for a new single
owner. The core is the Web UI and its owner-controlled SQLite database. An
agent, Telegram, and Hermes are all optional.

## What you are setting up

- **Open Fitness:** the record of truth for workouts, recovery, body
  measurements, meals, plans, and activity energy.
- **Web UI:** lightweight manual actions that are faster to tap than describe,
  plus one place to review progress and confirmed decisions.
- **Optional automations:** for specific repeatable updates, such as Apple
  Health Active Energy through an iPhone Shortcut or a direct API integration.
  Open Fitness does not provide a general file-import screen.
- **Optional owner-selected agent:** for photos, copied summaries, ad-hoc meals,
  corrections, questions, analysis, and owner-confirmed routine-template
  changes through the authenticated API/MCP boundary.

The documented portable path uses the vendor-neutral
[Agent Plugins v1](https://agent-plugins.org/specification) package under
`agent-plugin/`. A trusted client may instead reproduce the same contract over
the authenticated HTTP API. Open Fitness does not require a built-in chatbot,
Telegram, Hermes, a specific model provider, or agent memory.

## 1. Install Open Fitness

You need Git, Node.js 22.18 or newer, and a private machine on which the app and
SQLite file can remain owner-only.

Follow [Generic self-hosting](operations/SELF-HOSTING.md) to:

1. clone the repository and run `npm ci`;
2. create a fresh database outside the repository;
3. configure `.env.local`, including the owner password and session secret;
4. build and run the app on loopback; and
5. expose it remotely only through private HTTPS or a VPN you control.

`npm start` automatically reads the owner-only `.env.local` file when it is
present; no manual shell export is required for normal startup.

Use a unique password-manager-generated value or long passphrase of at least 12
Unicode characters. An upgraded installation can still verify an older hash
whose password is shorter so the owner is not locked out, but rotate that hash
promptly; the replacement must meet the new minimum and will invalidate old
owner sessions. The self-hosting runbook also documents the process-local login
failure limit and its trusted-proxy assumptions.

A fresh database defaults to English and `UTC`. Choose the owner's actual IANA
timezone and preferred locale during initialization or first-run setup. The
timezone controls the meaning of “today” and the local date stored for new
records; a later timezone change does not rewrite historical local dates.

## 2. Complete Web UI setup

Sign in and complete the initial profile before connecting an agent:

- choose the display language (`en`, `zh-HK`, `zh-TW`, or `zh-CN`);
- confirm the goal and ordered training/recovery cycle;
- enter a daily calorie target, protein target, and effective date; the calorie
  value is a fixed intake target and is not increased by recorded activity;
- add routine items and alternatives only when they are useful, or leave them
  empty until completed workout history can support an agent-proposed draft; and
- optionally configure the owner's usual venue in the selected agent; otherwise
  leave venue absent until the owner or source data supplies one.

The profile's `preferredLocale` is the default language for system copy and for
new titles, summaries, and notes composed by an agent for storage. An agent may
reply in the language used in the current chat. Exact wording explicitly chosen
by the owner, brands, and product names remain verbatim. When an agent interprets
a screenshot, photo, or copied export, it composes user-facing fields in
`preferredLocale` and retains raw wording only in a supported source/evidence
field. Changing locale does not rewrite existing records.

At this point the app is usable without an agent. Test login, one manual record,
the Log, and a backup before adding integrations.

Apple Health Active Energy is optional. Follow the generic
[intraday overwrite and next-day settlement contract](APPLE-HEALTH.md) for an
iPhone Shortcut. Workout and body-measurement integrations remain
source-specific.

## 3. Connect any compatible agent (optional)

### Privacy boundary

An optional agent can send health records, photos, and prompts to the selected
chat/model provider. Before connecting it, the owner must review that
provider's data-retention, model-training, and privacy terms and give informed
consent to that processing. Use the least data needed and disposable UAT data
and credentials during acceptance. Open Fitness cannot control provider data
after transmission.

Enable `FITNESS_API_TOKEN` in the owner-only environment with a random secret
that is different from the session and health-sync secrets. Never paste it into
a prompt. The MCP client passes it only to the connector subprocess.

Install or enable the repository's `agent-plugin/` package with an
[Agent Plugins-compatible client](https://agent-plugins.org/compatible-clients).
Review [`plugin.json`](../agent-plugin/plugin.json) and
[`mcp.json`](../agent-plugin/mcp.json) before enabling the package. The client
discovers `agent-plugin/skills/open-fitness/` and starts the
stdio server named `of`; no client-specific manifest or copied MCP config is
required.

Configure `FITNESS_API_BASE_URL` and `FITNESS_API_TOKEN` through the client's
private environment or secret store so they reach the MCP subprocess. Do not
put either value in `agent-plugin/plugin.json`, `agent-plugin/mcp.json`, a prompt, or another tracked
file. A compatible setup must:

- launch the checked-in local connector;
- expose only `fitness_read` and `fitness_write` to the model;
- keep the API URL and token in the client's secret/environment store;
- use a model that can reliably call the two structured tools;
- authorize the owner before writes;
- require an explicit owner confirmation of the exact diff before a full
  routine-template update; and
- provide native image input only if label/photo interpretation is wanted.

Vision is not required for text, API reads, calculations, or coaching. It is
required if the chosen agent must inspect photos. Image text is evidence, never
permission to write.

If the client cannot load the packaged Skill, give it this small bootstrap
instruction; the connector exposes the full versioned workflow:

> Open Fitness is the record of truth. Begin by calling `fitness_read` with
> resource `instructions`. Before composing a write, read the exact operation's
> `write_contract`. Use only `fitness_read` and `fitness_write`. Never guess
> missing values. Only acknowledge a write when `fitness_write` returns
> `succeeded`; stop on `conflict`, `failed`, or `uncertain`.

Agent memory is optional and may keep stable preferences or constraints only.
Do not duplicate meals, workouts, measurements, calculations, or temporary
plans outside Open Fitness.

For Telegram through Hermes, use the
[Hermes portable-install notes](../integrations/hermes/README.md) after the
package smoke test works. Hermes is a client choice, not a prerequisite.

## 4. Smoke-test on disposable data

Do not connect a new agent configuration to the live database first.

1. Start the intended build against a disposable database and token.
2. Confirm the agent can see exactly `fitness_read` and `fitness_write`.
3. Ask it to read `instructions`, then `snapshot`; confirm the profile locale,
   timezone, and empty/expected state.
4. Create one small test record, read it in the Web UI, and confirm a repeated
   delivery does not duplicate it.
5. Confirm agent-composed saved wording uses `preferredLocale`, explicit owner
   wording and brand/product names stay unchanged, and an unprovided venue
   remains null.
6. Test one correction and ensure the final Log reflects it.
7. Read `training_template`; if template management is wanted, confirm that its
   history proposal is read-only, then approve one disposable diff and verify
   the final ordered template in the Web UI.
8. If photo input is required, test a real label and require confirmation before
   saving extracted values.

Only after all checks pass should the agent endpoint and token be changed to
the live loopback API. A `succeeded` write is acknowledged naturally; a
`conflict`, `failed`, or `uncertain` outcome is reported without guessing or a
compensating write.

## 5. Operate and update

- Use the Web UI for quick taps and consolidated review.
- Use the agent for high-entropy text/images and record-grounded advice.
- Use an automation for a supported repeatable update instead of entering it
  twice.
- Back up before migrations or upgrades; follow
  [Backup and restore](operations/BACKUP-RESTORE.md).
- Rotate any legacy owner password shorter than 12 Unicode characters by
  generating a new hash through the documented stdin-only command; never put
  the plaintext password in an environment file or shell argument.
- For a service-managed installation, keep releases under an owner-controlled
  `app/releases/<40-character-commit>` tree with an atomic `app/current`
  symlink. Use the
  [self-host activation workflow](operations/SELF-HOSTING.md#6-upgrade-an-existing-self-host-safely)
  so tests and the build finish before stop/migration, and so failed health
  acceptance restores the database and code release together.
- Re-run the disposable MCP smoke test after changing the app, connector,
  model, agent, or adapter.

To rebuild on another machine, install the same application and Agent Plugin
revision, restore the SQLite backup with the runbook, recreate owner-only
secrets in the selected client, and repeat the smoke test. Do not copy private
data, tokens, or certificates into Git.
