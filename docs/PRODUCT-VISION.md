# Open Fitness product vision

## Product statement

Open Fitness is a simple, agent-first fitness record and coaching app with
lightweight manual controls. It brings training, recovery, nutrition, body
measurements, and activity energy into one auditable record without forcing the
owner to replace the apps, devices, or agent they already use.

Its interaction model is deliberately short:

> Talk for the messy stuff. Tap for the quick stuff. See the full picture.

Agent-first does not mean agent-only. The agent does the interpretation and
other heavy lifting; the owner keeps direct control of quick, concrete actions;
and integrations carry structured data that should not be entered twice.

The product is not another all-purpose workout tracker with a chatbot attached.
Its job is to make fragmented fitness evidence coherent, keep decisions outside
ephemeral chat history, and expose a small trustworthy boundary that any
authorized agent or automation can use.

## Interaction ownership

Each input belongs in the path that makes it easiest and least error-prone.

1. **An owner-selected agent** handles high-entropy input: photos, copied workout
   summaries, food labels, ad-hoc meals, questions, and interpretation. The
   agent may use the authenticated API or MCP connector; it is not part of the
   database and is not tied to a particular provider or chat transport.
2. **The Web UI** provides lightweight manual controls for actions that are
   faster to perform directly: choosing
   a saved food or meal, ticking sets, correcting weight/RIR, reviewing trends,
   changing a schedule state, and confirming or revising a decision.
3. **Integrations** handle structured, repeatable data. Examples include Apple
   Health Active Energy and exports from workout or body-measurement apps.

Open Fitness should not ask the owner to repeat context merely because the app
could collect it. If an upstream fitness app already records a workout well,
Open Fitness should import it instead of rebuilding that workflow by default.

### Lightweight manual control rule

Manual input exists as a fast path and a fallback, not as a second full-time
tracking job.

- Keep frequent actions one tap or one short edit whenever possible.
- Let the owner review, confirm, consume, cancel, or correct an agent-created
  record without reconstructing it manually.
- Put complete manual creation flows behind progressive disclosure when an
  agent or integration normally supplies the same data.
- Do not duplicate a specialist workout, food, health, or scale app merely to
  claim that every record can be entered by hand.
- A manual control earns primary-screen space only when it is faster than
  telling the agent or using the source application.

## Record model

The SQLite database is the canonical record. The public write boundary must make
authentication, idempotency, auditability, and appropriate post-write
verification explicit for each route.

- Preserve raw source evidence where it helps explain or correct an import.
- Store normalized facts with stable IDs and enums; presentation text must not
  determine business behaviour.
- Keep provenance, timestamps, revisions, and confidence where applicable.
- Treat unknown values as unknown rather than zero.
- Keep agent memory limited to stable preferences that are not already records.
- Never turn chat history into a second source of truth.

## Training and exercise model

A training cycle is an ordered sequence of user-defined training or recovery
days. Names such as Leg, Push, and Pull are examples, not schema concepts.

Exercises should eventually use owner-scoped stable IDs with aliases and raw
source names. An existing exercise is selected when it is known; new free text
can create a reusable catalog entry after confirmation or a deterministic
import. Built-in translations, if any, attach to the stable ID. User-created
names remain exactly as entered.

Routine alternatives are optional rules, not extra steps in the normal flow.
They may be scoped to a date, a routine template, or optional venue metadata.
The UI should expose the least persistent scope that solves the immediate
problem, while more durable rules remain available as progressive disclosure.

### Venue rule

Venue is opportunistic metadata, never a required workout choice.

- Do not prompt the owner to select a venue before planning or training.
- An owner may configure a default venue in the selected agent. An explicit
  venue in the current request or source data takes priority.
- When neither the current request, source data, nor an owner-configured default
  supplies a venue, it remains unknown and must not be inferred from prose.
- Venue-specific ranking or alternatives may run only when a concrete venue is
  present.
- An agent may pass an owner-supplied venue as request-scoped planning context;
  this applies venue rules without making venue selection a normal UI step.

Historical venue notes remain valid records, but they do not become a default
unless the owner deliberately configures one.

Structured cycles use stable phase IDs and explicit training/recovery kinds.
Legacy recovery-completion prose is read only for legacy text cycles; an
explicit structured recovery-completion event remains unsupported until that
event can carry a phase ID. A recovery-status note affects a structured
training phase only when it is linked to a session in that phase or its
structured area matches a configured routine item. Unscoped recovery prose is
kept as a record but does not silently reduce an unrelated phase.

## Durable decisions

The Web UI should preserve useful conclusions produced by the owner and agent,
including the decision, supporting evidence, date, scope, and later revision.
Examples include a training adjustment, a recovery constraint, a nutrition
target change, or an exercise substitution. It should not save every chat turn.

## UX principles

- High-frequency actions are direct, reversible, and usually one tap.
- Automation must remove work rather than create reconciliation work.
- Optional metadata stays out of the primary flow unless it changes the current
  decision.
- Complexity appears progressively; configuration does not dominate daily use.
- Agent-written explanations are concise by default and expandable when detail
  is useful.
- Mobile is the primary daily surface; tablet and desktop support review and
  denser analysis without becoming separate products.

## Product boundaries

Open Fitness is deliberately not trying to become:

- a mandatory built-in AI chat product;
- a replacement for every workout, health, or scale application;
- a giant global exercise or food database;
- a social network, gym-management system, or multi-tenant SaaS platform;
- a medical device or a substitute for professional medical care.

These boundaries are the reason the product can stay small: one coherent,
private record with an integration-first and agent-neutral interface.

## Localization boundary

The target product locales are `zh-HK`, `zh-TW`, `zh-CN`, and `en`.
Locale and timezone are independent. System labels and generated system copy may
be localized. Exact owner-chosen wording, brand/product names, and directly
imported source fields remain verbatim. New user-facing text an agent composes
for storage uses profile `preferredLocale` at composition time; the Web UI never
retro-translates stored content. See [I18N.md](I18N.md) for the contract.

## A feature earns its place when

Add a feature only if it does at least one of the following:

1. removes repeated manual entry;
2. improves the correctness or recoverability of the record;
3. makes a decision easier to act on or find later; or
4. enables a user-selected client without coupling the core to that client.

If an existing specialist app already performs the workflow better and an
import or link is sufficient, integration is the preferred feature.
