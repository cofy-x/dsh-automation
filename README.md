# dsh-automation

Durable background automation for DeepSeek Harness.

`dsh-automation` accepts persistent Runs from a local command, cron, webhook, or another DSH plugin and executes them through canonical DSH Agents and Sessions. It is separate from the core `@deepseek-ai/dsh-jobs` service, which tracks process-local background work owned by an already-live Agent.

## Quick start

Run directly from a source checkout:

```sh
pnpm install
pnpm automation init
pnpm automation doctor
pnpm automation start
```

After the packages are published, the same product entry point is available globally:

```sh
npm install --global dsh-automation-cli
dsh-automation init
dsh-automation doctor
dsh-automation service install
dsh-automation submit "check the current project's failing tests"
dsh-automation status
```

`init` idempotently creates the dedicated DSH profile and installs matching service and application bundles. It uses the current source checkout during development and exact registry versions in a published installation. `doctor` checks Node, pnpm, the bundled DSH launcher, the profile, and durable storage. `service install` creates a launchd user agent on macOS or a systemd user unit on Linux; `service status|logs|restart|stop|uninstall` expose the same lifecycle on both systems.

Use `start` for a foreground Worker in a container or an existing supervisor. `submit`, `status`, `list`, `show`, `cancel`, `retry`, `events`, `pause`, `drain`, `resume`, `consumers`, and `purge` pass through to the dedicated automation application. Advanced operators can still use `dsh --profile automation ...`, but it is no longer the primary user interface.

The durable store uses SQLite WAL, trigger-scoped idempotency keys, leased Attempts, fencing tokens, deterministic Session identifiers, and explicit `indeterminate` recovery when a crashed Agent turn may already have produced external side effects.

Inbox-only recovery uses the released Agent contract only: a plugin-owned steering item wakes the resumed loop, and an agent-scoped `agent/pre-step` listener removes that control item before request material is committed. The original identified task message remains canonical and is delivered once; a crash after `turn/start` is never replayed automatically.

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
