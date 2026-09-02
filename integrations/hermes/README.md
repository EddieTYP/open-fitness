# Install with Hermes

Hermes is one optional client for the portable Agent Plugins v1 package under
`agent-plugin/`. Open Fitness does not require Hermes, Telegram, or a particular
model provider. Complete [new owner onboarding](../../docs/ONBOARDING.md) and
test the application with disposable UAT data before enabling any agent.

An optional agent can send health records, photos, and prompts to the selected
chat/model provider. Review that provider's data-retention, model-training, and
privacy terms, obtain informed consent, and use the least data needed. Open
Fitness cannot control provider data after transmission.

Install the minimal package without enabling it, review
`agent-plugin/plugin.json`, `agent-plugin/mcp.json`, and
`agent-plugin/skills/open-fitness/SKILL.md`, then enable the package:

```sh
hermes plugins install EddieTYP/open-fitness#agent-plugin --no-enable
hermes plugins list
hermes plugins enable open-fitness
```

Before enabling, provide `FITNESS_API_BASE_URL` and `FITNESS_API_TOKEN` through
the selected Hermes profile's private environment or secret mechanism. Do not
put either value in the repository, portable manifests, prompts, or command
arguments. The package declares the stdio MCP server as `of`; it exposes only
`fitness_read` and `fitness_write`.

After enabling, use Hermes's skill listing to find the namespaced Open Fitness
skill and confirm that only those two MCP tools are available. Read resource
`instructions` before the first write, then complete the disposable smoke test
in [new owner onboarding](../../docs/ONBOARDING.md#4-smoke-test-on-disposable-data)
before connecting the live database.
