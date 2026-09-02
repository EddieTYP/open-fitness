# How Open Fitness works

Open Fitness keeps one owner-controlled SQLite record while allowing each kind
of input to use the least-friction path. An agent is optional: the Web UI and
structured integrations use the same authenticated application boundary.

## Three input paths, one record

```mermaid
flowchart LR
  owner[Owner]
  agent[Owner-selected agent]
  plugin[Open Fitness Agent Plugin]
  web[Mobile-first Web UI]
  source[Optional automation<br/>Shortcut or API]
  api[Authenticated Open Fitness API]
  db[(Owner-controlled SQLite)]

  owner -->|photos, text, questions| agent
  agent --> plugin
  plugin --> api
  owner -->|quick taps and review| web
  web --> api
  source -->|repeatable observations| api
  api --> db
```

Use the Web UI when a tap is faster, an agent when the input needs
interpretation, and an automation for a supported repeatable update. The
SQLite database remains the canonical record.

## One verified write

```mermaid
sequenceDiagram
  participant A as Agent
  participant P as Plugin connector
  participant API as Open Fitness API
  participant DB as SQLite

  A->>P: fitness_write(canonical intent, requestId)
  P->>P: normalize and validate
  P->>API: required read-only preflight
  P->>API: one authenticated mutation
  API->>DB: atomic write + audit + idempotency receipt
  DB-->>API: committed entity or revision
  API-->>P: authoritative response
  P->>API: exact readback only when required
  P-->>A: bounded status and facts
```

The connector never guesses a second endpoint after a failed write. Repeating
the same request ID with the same canonical body resolves idempotently; changing
the body under the same ID conflicts.

## Privacy and trust boundary

```mermaid
flowchart LR
  subgraph owner["Owner-controlled environment"]
    browser[Browser]
    proxy[Private HTTPS or trusted VPN]
    app[Loopback Open Fitness app]
    plugin[Agent Plugin connector]
    db[(SQLite and backups)]
    browser --> proxy --> app --> db
    plugin -->|owner API token| app
  end

  subgraph provider["Optional selected agent or model provider"]
    agent[Conversation and image interpretation]
  end

  browser -. optional prompts or photos .-> agent
  agent -->|two bounded MCP tools| plugin
```

The public package contains no owner data, token, certificate, database, or
host-specific deployment. If an external agent is used, the owner should review
that provider's retention and model-training terms and send only the data needed
for the task.

## Product views

The screenshots below are captured from the real Web UI backed by a disposable
database containing synthetic data only.

| Today | Nutrition |
| --- | --- |
| ![Open Fitness mobile Today view with a synthetic training plan](assets/open-fitness-today-mobile.png) | ![Open Fitness mobile Nutrition view with a synthetic pending meal plan](assets/open-fitness-nutrition-mobile.png) |
