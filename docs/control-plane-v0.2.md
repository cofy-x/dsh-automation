# Automation Control Plane v0.2

This document fixes the cross-plugin contract for the v0.2 implementation. `dsh-automation` is the only owner of durable execution, while cron and webhook remain independent producers of verified occurrences.

## Delivery contract

A Trigger adapter first persists its own source fact, then submits one immutable Automation Run. The submission identity is `(trigger.kind, trigger.sourceId, trigger.idempotencyKey)`; retrying the same submission returns the existing Run. `occurrenceId` is the adapter's human/audit identity and is not a substitute for an idempotency key.

| Producer | `kind` | `sourceId` | `occurrenceId` | `idempotencyKey` |
|:---|:---|:---|:---|:---|
| CLI | `manual` | `cli` | generated command occurrence | optional caller key |
| dsh-cron | `cron` | stable job ID | scheduled RFC 3339 instant | versioned job ID plus scheduled instant |
| dsh-webhook | `webhook` | stable hook ID | verified external delivery ID | hook ID plus verified delivery ID |

Adapters never call `Agent.followup()`, `steer()`, or `inject()`. A Run targets a fresh canonical Session. Session-local reminders remain the responsibility of the shipped DSH schedule capability; system automation does not concurrently mutate an interactive Session.

## Execution and recovery

Each claim creates one fenced Attempt and deterministic fresh Session identity. A lost claim may be retried only before durable dispatch. Once canonical evidence contains `turn/start`, an interrupted or unknowable outcome is terminal `indeterminate`; only an explicit operator retry may create a new Run, linked through `retryOf`. Retrying an `indeterminate` Run requires an explicit acknowledgement because external side effects may already exist.

Concurrency is admission control, not an execution shortcut. A Run may carry a bounded `concurrencyKey` and positive `concurrencyLimit`; the database claim transaction counts active Runs with the same key before admitting another. Worker slots add local parallelism, while the database remains authoritative across processes.

## Durable event feed

`run_events.seq` is the global monotonically increasing cursor. Consumers request a bounded page after a cursor and checkpoint the returned cursor only after applying the page. Re-reading a page is safe: adapters reconcile by Run ID and event sequence. Process-local notifications are latency hints only and can never be the only settlement path.

Cron stores schedule definitions and occurrence-to-Run links. Webhook stores verification receipts, bounded replay material, callback rules, and delivery-to-Run links. Both reconcile Run settlement from the durable event feed after restart; neither copies Session history or implements Agent outcome tracking.

## Control and retention

Queue pause and drain mode are durable and prevent every process from making new claims without interrupting active Attempts. The `drain` management command enters drain mode and waits for the active count to reach zero; `resume` is required to admit work again. Worker shutdown independently stops its slots, waits through the configured grace, and only then cancels remaining turns. Purge is confirmed, bounded, terminal-only, consumer-checkpoint protected, and deletes Automation bookkeeping without deleting canonical Sessions. A persisted prune watermark makes stale cursors fail explicitly even after every retained event has been deleted.

## Schema evolution

Schema v2 is an in-place transaction from v1. It adds trigger occurrence and concurrency columns, supporting indexes, queue control, durable event consumers, and an event-retention watermark. The migration is structurally compared with a fresh v2 database in tests. Every later version must provide a sequential migration and tests from the immediately previous schema plus a fresh-database equivalence test. Unknown future versions fail closed.
