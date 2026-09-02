# Open Fitness

Language: English | [繁體中文](README_zh-TW.md) | [简体中文](README_zh-CN.md)

Open Fitness is a private, self-hosted fitness journal. It keeps workouts,
meals, body measurements, recovery notes, and training plans in one place,
without asking you to stop using the apps and devices you already rely on.

You can record things directly in the mobile-friendly Web UI, connect an AI
assistant for photos and free-form messages, or run an optional automation for
a specific repeatable update, such as an iPhone Shortcut. The Web UI works on
its own.

| Today | Nutrition |
| --- | --- |
| ![Open Fitness mobile Today view with a synthetic training plan](docs/assets/open-fitness-today-mobile.png) | ![Open Fitness mobile Nutrition view with a synthetic pending meal plan](docs/assets/open-fitness-nutrition-mobile.png) |

## Training, nutrition, and progress

### Training

- Define your own sequence of training and recovery days; it does not have to
  be Leg/Push/Pull.
- Build routine templates and alternatives, and mark a session as normal,
  deload, or test.
- Record a workout in one go, or split it across different times and venues.
- Compare it with the relevant previous session. A progression change enters
  the plan only after you confirm it.

### Nutrition

- Save foods and meal combinations that you use often.
- Keep pending meal plans separate from food you have actually eaten.
- Track calorie and protein targets.
- Import provisional or settled Active Energy from an optional source such as
  an iPhone Shortcut.

### Progress

- Follow body weight, body composition, strength, cardio, and recovery over
  time.
- Keep corrections in the history instead of quietly replacing the original
  record.
- Use the Log to review the full timeline rather than relying on chat history.

## Ways to record

All three input paths update the same SQLite database:

1. **Web UI** for quick manual entries and everyday review.
2. **AI assistant (optional)** for photos, natural-language reports,
   corrections, questions, and guidance based on your records.
3. **Automations (optional)** for specific repeatable updates, such as an
   iPhone Shortcut or direct API integration.

When an assistant writes through the bundled plugin, Open Fitness checks the
request, makes one change, and reads back the saved result before confirming
success. If a value is missing, it stays missing rather than being guessed.

See [How Open Fitness works](docs/WORKFLOWS.md) for diagrams of the input paths,
write flow, and privacy boundaries.

## Set up Open Fitness

Open Fitness currently supports one owner. You need Git, Node.js 22.18 or
newer, and a private machine for the application and SQLite database.

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/EddieTYP/open-fitness.git
cd open-fitness
npm ci
```

Then follow [Generic self-hosting](docs/operations/SELF-HOSTING.md) to:

1. create an empty database outside the repository;
2. generate the password hash and separate secrets;
3. copy `.env.example` to an owner-only `.env.local`;
4. build and start the app on loopback; and
5. if you need remote access, put it behind private HTTPS or a VPN you control.

After signing in, choose your language, timezone, goal, training cycle, and
nutrition targets. You can start using the Web UI immediately.

[New owner onboarding](docs/ONBOARDING.md) covers the whole process, including
optional automations and AI setup.

## Connect an AI assistant (optional)

The `agent-plugin/` directory contains a portable
[Agent Plugins v1](https://agent-plugins.org/specification) package. A
compatible client loads the Open Fitness skill and two tools:

- `fitness_read` gets only the information needed for the current task;
- `fitness_write` checks a requested change and verifies what was saved.

Open Fitness does not depend on a particular model provider, chat app, memory
system, or agent client. The plugin contains no credentials. Your client must
pass `FITNESS_API_BASE_URL` and `FITNESS_API_TOKEN` through its private
environment or secret store.

An assistant is useful when something is awkward to enter by hand, but Open
Fitness remains the permanent record. Before sending health data or photos to
an AI provider, check that provider's data-retention, model-training, and
privacy terms.

See the [optional AI setup](docs/ONBOARDING.md#3-connect-any-compatible-agent-optional)
for details. [Hermes](integrations/hermes/README.md) is one compatible client,
not a requirement.

## Data and privacy

- Your SQLite database is the source of truth.
- Web login, AI access, and automation/API access use separate credentials.
- Health records, credentials, databases, exports, and private certificates
  should never be committed to Git.
- The app listens on loopback. Remote access is left to a private HTTPS proxy or
  VPN chosen by the operator.
- If you connect an AI provider, data sent through that client is also subject
  to the provider's privacy terms.

Read [New owner onboarding](docs/ONBOARDING.md) before connecting an assistant,
and [Backup and restore](docs/operations/BACKUP-RESTORE.md) before migrating or
restoring a database.

## Languages and current scope

The product and Web UI target `en`, `zh-HK`, `zh-TW`, and `zh-CN`. Locale
selection and the Web UI are available in all four languages, including
generated training plans, session reviews, progress commentary, and log labels.
Owner-specified wording, brand/product names, and directly imported source
fields remain as recorded. When an agent composes for storage, it uses the
profile's preferred locale. The UI never retro-translates saved content. See
[Internationalization](docs/I18N.md) for details.

Version 0.1.0 is single-owner and self-hosted. It does not include a hosted
cloud service, multi-user accounts, or a native iOS app. Open Fitness is not a
medical device and does not replace professional medical advice.

## Documentation

| Guide | What it covers |
| --- | --- |
| [New owner onboarding](docs/ONBOARDING.md) | First setup and optional connections |
| [Generic self-hosting](docs/operations/SELF-HOSTING.md) | Installation, startup, and safe upgrades |
| [Backup and restore](docs/operations/BACKUP-RESTORE.md) | Protecting and restoring the SQLite database |
| [How Open Fitness works](docs/WORKFLOWS.md) | Input paths, checked writes, and privacy boundaries |
| [Product vision](docs/PRODUCT-VISION.md) | Design principles, direction, and non-goals |
| [Security policy](SECURITY.md) | Reporting a vulnerability privately |

## Development

```bash
npm ci
npm run check
npm run lint
npm test
npm run build
```

Never point development or tests at a live SQLite database. Database and release
operations are documented under `docs/operations/` and stop when a required
path or safety check is missing.

## License

Open Fitness core application code is licensed under
[AGPL-3.0-or-later](LICENSE). See [NOTICE](NOTICE) for scope and third-party
boundaries. Organizations that need different terms may ask the copyright
holder about commercial licensing.

External code contributions are temporarily closed until the inbound licensing
terms are published; see [CONTRIBUTING.md](CONTRIBUTING.md).
