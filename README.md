# dsh-automation

Durable background automation for DeepSeek Harness.

`dsh-automation` accepts persistent Runs from a local command, cron, webhook, or another DSH plugin and executes them through canonical DSH Agents and Sessions. It is separate from the core `@deepseek-ai/dsh-jobs` service, which tracks process-local background work owned by an already-live Agent.

The alpha command surface is:

```sh
dsh --profile automation worker
dsh --profile automation worker --slots 4 --shutdown-grace-ms 60000
dsh --profile automation worker --once --json
dsh --profile automation submit "check the current project's failing tests"
dsh --profile automation status
dsh --profile automation list
dsh --profile automation show <run-id>
dsh --profile automation cancel <run-id>
dsh --profile automation retry <run-id>
dsh --profile automation events --after-seq 0 --json
dsh --profile automation pause --reason maintenance
dsh --profile automation drain --reason upgrade
dsh --profile automation resume
dsh --profile automation consumers --json
dsh --profile automation purge --before 2026-08-01T00:00:00Z --confirm
```

The durable store uses SQLite WAL, trigger-scoped idempotency keys, leased Attempts, fencing tokens, deterministic Session identifiers, and explicit `indeterminate` recovery when a crashed Agent turn may already have produced external side effects.

Inbox-only recovery uses the released Agent contract only: a plugin-owned steering item wakes the resumed loop, and an agent-scoped `agent/pre-step` listener removes that control item before request material is committed. The original identified task message remains canonical and is delivered once; a crash after `turn/start` is never replayed automatically.

Install the service and its dedicated application bundle into the automation profile, then let the operating system supervise the Worker:

```sh
dsh plugin --profile automation add /path/to/dsh-automation /path/to/dsh-automation/packages/app-bundle
dsh --profile automation worker
```

`dsh-automation` is a composable service bundle; `dsh-automation-app` owns only the automation profile's command parser and process application. Web, cron, webhook, and other host profiles install only `dsh-automation`, so they cannot acquire a competing command-line application. Use launchd, systemd, or another process supervisor with one slot in the first deployment, then scale slots after reviewing workload isolation. Management commands are short-lived processes over the same database at `$DSH_HOME/automation/automation.db`; stopping Console does not stop automation. Cron and webhook remain separate Trigger plugins: they persist source facts, submit idempotent fresh-Session Runs through `ctx.automation`, and reconcile the durable global event feed.

See [the operations guide](docs/operations.md) for the stable exit contract, health semantics, upgrade procedure, and launchd/systemd templates. The [architecture guide](docs/architecture.md) defines the module boundaries and safety invariants that keep persistence separate from canonical DSH execution. `status` checks the durable store and queue; the supervisor remains the authority for Worker-process liveness.

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
