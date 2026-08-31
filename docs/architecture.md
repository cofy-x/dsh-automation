# dsh-automation architecture

`dsh-automation` is a durable orchestration plugin, not an Agent implementation. DSH owns canonical Sessions, Agent execution, models, tools, permissions, and credentials; this package owns Run scheduling state, leased Attempts, recovery classification, and the operator command surface.

## Module boundaries

| Module | Responsibility | May depend on |
|:---|:---|:---|
| `domain.ts` | Branded identifiers, requests, Run states, validation | No persistence or runtime modules |
| `store/schema.ts` / `store/database.ts` | Sequential schema migrations, private SQLite lifecycle, row decoding, transaction primitives | Domain and store types |
| `store/runs.ts` / `store/attempts.ts` | Submission and management versus lease-fenced live Attempt lifecycle | Store database |
| `store/query.ts` / `store/retention.ts` | Cursor-bounded reads, durable consumers, pruning watermark, terminal purge | Store database |
| `store/control.ts` | Persistent running, paused, and draining admission modes | Store database |
| `store/recovery.ts` | Expired lease classification, takeover fencing, recovery settlement | Store database |
| `store.ts` | Stable public persistence facade | Internal store modules |
| `worker/recovery.ts` | Canonical Session evidence and inbox-only wake filtering | Published DSH event contracts |
| `worker/agent-runtime.ts` | Fresh/resumed Agent composition through public DSH services | Published DSH Agent services |
| `worker.ts` / `worker/pool.ts` | One-slot execution sequencing and multi-slot supervisor lifecycle | Automation service and worker modules |
| `startup.ts` / `startup/management.ts` / `app.ts` | Command parsing and bounded process exit contract | Public automation service |

Dependencies point inward toward domain contracts and small persistence/runtime seams. Internal modules never import `app.ts`, and trigger adapters depend only on the public `AutomationService` submission surface.

The source-size check caps each `src/**/*.ts` module at 300 physical lines. This is a regression signal, not the architecture rule itself: a file should be split earlier whenever it owns more than one lifecycle or state-machine responsibility.

## Safety invariants

- The automation database stores Session identifiers and bounded outcome excerpts, never a second copy of Session history.
- Every lease-owned mutation is fenced by Run, Attempt, and lease token.
- An expired Attempt may be requeued only when durable evidence proves dispatch never began.
- Inbox-only recovery resumes the same canonical Session and removes only the plugin-owned wake control before request material is committed.
- Any crash after `turn/start`, or any ambiguous model/tool side effect, settles as `indeterminate` and is never automatically retried.
- Trigger adapters persist their source fact before idempotent submission and reconcile settlement only through the global durable event feed.
- Purge cannot pass a registered consumer checkpoint, and readers behind the persisted prune watermark receive `EVENT_CURSOR_EXPIRED`.
- Public imports remain `dsh-automation`, `dsh-automation/store`, `dsh-automation/startup`, and `dsh-automation/app`; internal module layout is not a compatibility surface.

## Change discipline

Schema changes belong in `store/schema.ts` and require an explicit migration/version decision plus migrated/fresh structural equivalence. Run or Attempt state-machine changes belong in their owning store module and require transition tests. Agent recovery changes require process-level SIGKILL coverage for the affected durability boundary. Supervisor or CLI changes require exit-contract tests and corresponding operations documentation.
