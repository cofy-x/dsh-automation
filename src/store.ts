/** SQLite WAL persistence and transactional Run state transitions. */

import {
  type RunClaim,
  type RunId,
  type RunSettlement,
  type RunState,
  type RunView,
  type SubmitRunRequest,
} from './domain.ts'
import { claimNext, heartbeat, markRunning, settle } from './store/attempts.ts'
import { StoreDatabase } from './store/database.ts'
import { drainQueue, pauseQueue, readQueueControl, resumeQueue } from './store/control.ts'
import {
  expiredDispatched as findExpiredDispatched,
  reclaimDispatched as reclaimExpiredDispatched,
  recoverUndispatchedExpired as recoverExpiredUndispatched,
  settleExpired as settleExpiredAttempt,
} from './store/recovery.ts'
import { queryEvents, queryRuns } from './store/query.ts'
import { checkpointConsumer, listConsumers, purgeTerminal, removeConsumer } from './store/retention.ts'
import { automationStatus, listRuns, requestRunCancel, retryRun, runEvents, submitRun } from './store/runs.ts'
import type { AutomationStatus, EventConsumer, EventPage, EventQuery, ExpiredAttempt, PurgeResult, QueueControl, RetryOptions, RunEvent, RunPage, RunQuery, StoreOptions } from './store/types.ts'

export { SCHEMA_VERSION } from './store/database.ts'
export type { AutomationStatus, EventConsumer, EventPage, EventQuery, ExpiredAttempt, PurgeResult, QueueControl, RetryOptions, RunCursor, RunEvent, RunPage, RunQuery, StoreOptions } from './store/types.ts'

/** Durable store shared by management processes and one or more local Workers. */
export class AutomationStore {
  private constructor(private readonly database: StoreDatabase) {}

  /** Validate the path, open SQLite, and transactionally reach the current schema. */
  static async open(options: StoreOptions): Promise<AutomationStore> {
    return new AutomationStore(await StoreDatabase.open(options))
  }

  /** Close this process's SQLite connection. */
  close(): void {
    this.database.close()
  }

  /** Submit one immutable Run, returning the existing Run for a duplicate idempotency key. */
  submit(request: SubmitRunRequest, now = Date.now()): { readonly run: RunView; readonly created: boolean } {
    return submitRun(this.database, request, now)
  }

  /** Return one Run by id. */
  get(id: RunId): RunView {
    return this.requireRun(id)
  }

  /** List Runs newest-first, optionally restricted to one state. */
  list(state?: RunState): RunView[] {
    return listRuns(this.database, state)
  }

  /** Query Runs through a bounded stable cursor. */
  query(query: RunQuery = {}): RunPage {
    return queryRuns(this.database, query)
  }

  /** Read the durable global Run event stream after one sequence cursor. */
  changes(query: EventQuery = {}): EventPage {
    return queryEvents(this.database, query)
  }

  /** Monotonically checkpoint one durable event-feed consumer. */
  checkpointConsumer(id: string, seq: number, now: number = Date.now()): EventConsumer {
    return checkpointConsumer(this.database, id, seq, now)
  }

  /** List durable event-feed consumers that protect retention. */
  consumers(): EventConsumer[] {
    return listConsumers(this.database)
  }

  /** Explicitly unregister one event consumer. */
  removeConsumer(id: string): boolean {
    return removeConsumer(this.database, id)
  }

  /** Purge a bounded set of terminal bookkeeping protected by consumer cursors. */
  purge(before: number, limit: number): PurgeResult {
    return purgeTerminal(this.database, before, limit)
  }

  /** Return a bounded health projection without reading prompts or Session data. */
  status(now: number = Date.now()): AutomationStatus {
    return automationStatus(this.database, now)
  }

  /** Read durable queue admission state. */
  control(): QueueControl {
    return readQueueControl(this.database)
  }

  /** Stop every Worker from claiming new Runs without interrupting active Attempts. */
  pause(reason?: string, now: number = Date.now()): QueueControl {
    return pauseQueue(this.database, now, reason)
  }

  /** Stop admission and persist that operators are waiting for active Attempts to finish. */
  drain(reason?: string, now: number = Date.now()): QueueControl {
    return drainQueue(this.database, now, reason)
  }

  /** Allow Workers to claim queued Runs again. */
  resume(now: number = Date.now()): QueueControl {
    return resumeQueue(this.database, now)
  }

  /** Atomically claim the next eligible Run and mint its fenced Attempt. */
  claimNext(workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    return claimNext(this.database, workerId, now, leaseDurationMs)
  }

  /** Extend a currently owned claim or running Attempt. */
  heartbeat(claim: RunClaim, now: number, leaseDurationMs: number): RunClaim {
    return heartbeat(this.database, claim, now, leaseDurationMs)
  }

  /** Commit the checkpoint that canonical DSH dispatch has become durable. */
  markRunning(claim: RunClaim, now: number): RunView {
    return markRunning(this.database, claim, now)
  }

  /** Settle a Run from a Worker that still owns the exact Attempt lease. */
  settle(claim: RunClaim, settlement: RunSettlement, now: number): RunView {
    return settle(this.database, claim, settlement, now)
  }

  /** Request cancellation, atomically terminating a queued Run. */
  requestCancel(id: RunId, now: number): RunView {
    return requestRunCancel(this.database, id, now)
  }

  /** Create an explicit replacement Run linked to one terminal original. */
  retry(id: RunId, options: RetryOptions, now: number = Date.now()): { readonly run: RunView; readonly created: boolean } {
    return retryRun(this.database, id, options, now)
  }

  /** Requeue expired claims that provably never crossed the durable dispatch checkpoint. */
  recoverUndispatchedExpired(now: number): RunId[] {
    return recoverExpiredUndispatched(this.database, now)
  }

  /** List expired dispatched Attempts that require canonical Session inspection. */
  expiredDispatched(now: number): ExpiredAttempt[] {
    return findExpiredDispatched(this.database, now)
  }

  /** Fence and take ownership of an expired dispatched Attempt for safe pre-turn resume. */
  reclaimDispatched(ref: ExpiredAttempt, workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    return reclaimExpiredDispatched(this.database, ref, workerId, now, leaseDurationMs)
  }

  /** Settle an expired dispatched Attempt from canonical Session recovery evidence. */
  settleExpired(ref: ExpiredAttempt, settlement: RunSettlement, now: number): RunView {
    return settleExpiredAttempt(this.database, ref, settlement, now)
  }

  /** Settle an expired dispatched Attempt whose canonical outcome is unknowable. */
  settleExpiredIndeterminate(ref: ExpiredAttempt, diagnostic: string, now: number): RunView {
    return this.settleExpired(ref, { state: 'indeterminate', outcome: 'interrupted', error: diagnostic }, now)
  }

  /** Read the append-only audit stream for one Run. */
  events(id: RunId): RunEvent[] {
    return runEvents(this.database, id)
  }

  private requireRun(id: RunId): RunView {
    return this.database.requireRun(id)
  }
}
