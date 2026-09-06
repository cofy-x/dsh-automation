# AGENTS.md

## Repository purpose

`dsh-automation` is the durable automation core for DeepSeek Harness. It owns persistent Run/Attempt state, trigger idempotency, local multi-process Worker leases, crash recovery classification, and the automation profile command surface. DSH owns Agent execution, canonical Sessions, models, providers, credentials, tools, permissions, and Session persistence.

## Architecture boundaries

- Do not implement or replace the core `@deepseek-ai/dsh-jobs` seam. That service owns process-local background work started by a live Agent; this repository owns system-level durable automation Runs.
- Store only automation scheduling state, bounded result excerpts, and canonical Session identifiers. Never copy complete Session events, reasoning, tool output, credentials, or provider state into the automation database.
- Trigger adapters call `ctx.automation.submit()`. They do not select live Agents, call `followup()`, or settle Run outcomes themselves.
- Every state transition is a SQLite transaction. Lease-fenced mutations match Run ID, Attempt number, and lease token.
- Never automatically retry a Run after canonical DSH evidence shows an interrupted turn or cannot prove whether model/tool side effects occurred. Settle it as `indeterminate`.
- Drive work only through public DSH services. Do not import source files, private package paths, or duplicate Agent loop behavior.
- Keep the user-facing `dsh-automation` executable in `packages/cli`. It may install profiles, delegate application commands, diagnose the product, and manage operating-system user services; it must not reimplement the durable store or DSH runtime.

## Tooling

Use Node.js 24 or newer and pnpm 11. Run the smallest relevant checks while iterating; before a commit run:

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run
pnpm run smoke:cli
```

Keep Markdown prose paragraphs on one physical line. Preserve MIT licensing. Do not commit credentials, local paths, generated stores, build output, or private endpoints.
