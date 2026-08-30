# dsh-automation

Durable background automation for DeepSeek Harness.

`dsh-automation` accepts persistent Runs from a local command, cron, webhook, or another DSH plugin and executes them through canonical DSH Agents and Sessions. It is separate from the core `@deepseek-ai/dsh-jobs` service, which tracks process-local background work owned by an already-live Agent.

The alpha command surface is:

```sh
dsh --profile automation worker
dsh --profile automation submit "check the current project's failing tests"
dsh --profile automation list
dsh --profile automation show <run-id>
dsh --profile automation cancel <run-id>
```

The durable store uses SQLite WAL, trigger-scoped idempotency keys, leased Attempts, fencing tokens, deterministic Session identifiers, and explicit `indeterminate` recovery when a crashed Agent turn may already have produced external side effects.

Install the checkout into a dedicated profile, then let the operating system supervise the Worker:

```sh
dsh plugin --profile automation add /path/to/dsh-automation
dsh --profile automation worker
```

Use launchd, systemd, or another process supervisor with a single Worker in the first deployment. Management commands are short-lived processes over the same database at `$DSH_HOME/automation/automation.db`; stopping Console does not stop automation. Cron and webhook integrations should remain separate Trigger plugins and submit through `ctx.automation`.

## Development

Requires Node.js 24 or newer and pnpm 11.

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run
```

MIT licensed.
