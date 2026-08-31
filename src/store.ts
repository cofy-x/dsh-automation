/** SQLite WAL persistence and transactional Run state transitions. */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AutomationError,
  type LeaseToken,
  type RunClaim,
  type RunId,
  type RunSettlement,
  type RunState,
  type RunView,
  type SubmitRunRequest,
} from './domain.ts'
import { decodeRun, StoreDatabase } from './store/database.ts'
import {
  expiredDispatched as findExpiredDispatched,
  reclaimDispatched as reclaimExpiredDispatched,
  recoverUndispatchedExpired as recoverExpiredUndispatched,
  settleExpired as settleExpiredAttempt,
} from './store/recovery.ts'
import { automationStatus, listRuns, requestRunCancel, runEvents, submitRun } from './store/runs.ts'
import type { AutomationStatus, ExpiredAttempt, RunEvent, SqlRow, StoreOptions } from './store/types.ts'

export { SCHEMA_VERSION } from './store/database.ts'
export type { AutomationStatus, ExpiredAttempt, RunEvent, StoreOptions } from './store/types.ts'

/** Durable store shared by management processes and one or more local Workers. */
export class AutomationStore {
  private constructor(private readonly database: StoreDatabase) {}

  private get db(): DatabaseSync {
    return this.database.sql
  }

  /** Validate the path, open SQLite, and initialize or verify schema v1. */
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

  /** Return a bounded health projection without reading prompts or Session data. */
  status(now: number = Date.now()): AutomationStatus {
    return automationStatus(this.database, now)
  }

  /** Atomically claim the next eligible Run and mint its fenced Attempt. */
  claimNext(workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    validateWorkerLease(workerId, now, leaseDurationMs)
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM runs
        WHERE state = 'queued' AND available_at <= ? AND cancel_requested_at IS NULL AND attempt_count < max_attempts
        ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(now) as SqlRow | undefined
      if (row === undefined) return undefined
      const run = decodeRun(row)
      const attempt = run.attemptCount + 1
      const token = randomUUID() as LeaseToken
      const leaseExpiresAt = now + leaseDurationMs
      const sessionId = `dsh-automation-${run.id}-a${attempt}`
      const changed = this.db.prepare(`
        UPDATE runs SET state = 'claimed', attempt_count = ?, current_attempt = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(attempt, attempt, now, run.id).changes
      if (changed !== 1) throw new AutomationError('INVALID_TRANSITION', `run ${run.id} was claimed concurrently`)
      this.db.prepare(`
        INSERT INTO attempts (
          run_id, attempt_no, state, worker_id, lease_token, lease_expires_at, session_id, claimed_at
        ) VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?)
      `).run(run.id, attempt, workerId, token, leaseExpiresAt, sessionId, now)
      this.event(run.id, now, 'claimed', { attempt, workerId, leaseExpiresAt, sessionId })
      return {
        run: this.requireRun(run.id),
        attempt,
        workerId,
        leaseToken: token,
        leaseExpiresAt,
        sessionId,
      }
    })
  }

  /** Extend a currently owned claim or running Attempt. */
  heartbeat(claim: RunClaim, now: number, leaseDurationMs: number): RunClaim {
    validateWorkerLease(claim.workerId, now, leaseDurationMs)
    const expires = now + leaseDurationMs
    const changed = this.db.prepare(`
      UPDATE attempts SET lease_expires_at = ?
      WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
        AND state IN ('claimed', 'running', 'cancelling') AND lease_expires_at > ?
    `).run(expires, claim.run.id, claim.attempt, claim.leaseToken, now).changes
    if (changed !== 1) leaseLost(claim)
    return { ...claim, run: this.requireRun(claim.run.id), leaseExpiresAt: expires }
  }

  /** Commit the checkpoint that canonical DSH dispatch has become durable. */
  markRunning(claim: RunClaim, now: number): RunView {
    return this.transaction(() => {
      const attemptChanged = this.db.prepare(`
        UPDATE attempts SET
          state = CASE WHEN state = 'cancelling' THEN 'cancelling' ELSE 'running' END,
          dispatched_at = ?
        WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
          AND state IN ('claimed', 'cancelling') AND lease_expires_at > ?
      `).run(now, claim.run.id, claim.attempt, claim.leaseToken, now).changes
      if (attemptChanged !== 1) leaseLost(claim)
      const runChanged = this.db.prepare(`
        UPDATE runs SET
          state = CASE WHEN state = 'cancelling' THEN 'cancelling' ELSE 'running' END,
          updated_at = ?
        WHERE id = ? AND state IN ('claimed', 'cancelling') AND current_attempt = ?
      `).run(now, claim.run.id, claim.attempt).changes
      if (runChanged !== 1) leaseLost(claim)
      this.event(claim.run.id, now, 'running', { attempt: claim.attempt, sessionId: claim.sessionId })
      return this.requireRun(claim.run.id)
    })
  }

  /** Settle a Run from a Worker that still owns the exact Attempt lease. */
  settle(claim: RunClaim, settlement: RunSettlement, now: number): RunView {
    return this.transaction(() => {
      const current = this.currentAttempt(claim.run.id, claim.attempt)
      if (current['lease_token'] !== claim.leaseToken || Number(current['lease_expires_at']) <= now) leaseLost(claim)
      const attemptState = settlement.state
      const changed = this.db.prepare(`
        UPDATE attempts SET state = ?, finished_at = ?, outcome = ?, result_excerpt = ?, error = ?
        WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
          AND state IN ('claimed', 'running', 'cancelling') AND lease_expires_at > ?
      `).run(
        attemptState,
        now,
        settlement.outcome,
        settlement.resultExcerpt ?? null,
        settlement.error ?? null,
        claim.run.id,
        claim.attempt,
        claim.leaseToken,
        now,
      ).changes
      if (changed !== 1) leaseLost(claim)
      const runChanged = this.db.prepare(`
        UPDATE runs SET state = ?, updated_at = ?, final_session_id = ?, outcome = ?, result_excerpt = ?, error = ?
        WHERE id = ? AND current_attempt = ? AND state IN ('claimed', 'running', 'cancelling')
      `).run(
        settlement.state,
        now,
        claim.sessionId,
        settlement.outcome,
        settlement.resultExcerpt ?? null,
        settlement.error ?? null,
        claim.run.id,
        claim.attempt,
      ).changes
      if (runChanged !== 1) leaseLost(claim)
      this.event(claim.run.id, now, 'settled', { attempt: claim.attempt, ...settlement })
      return this.requireRun(claim.run.id)
    })
  }

  /** Request cancellation, atomically terminating a queued Run. */
  requestCancel(id: RunId, now: number): RunView {
    return requestRunCancel(this.database, id, now)
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

  private currentAttempt(runId: RunId, attempt: number): SqlRow {
    const row = this.db.prepare('SELECT * FROM attempts WHERE run_id = ? AND attempt_no = ?').get(runId, attempt) as SqlRow | undefined
    if (row === undefined) throw new AutomationError('INVALID_TRANSITION', `attempt ${runId}/${attempt} does not exist`)
    return row
  }

  private requireRun(id: RunId): RunView {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow | undefined
    if (row === undefined) throw new AutomationError('RUN_NOT_FOUND', `run ${id} does not exist`)
    return decodeRun(row)
  }

  private event(runId: RunId, at: number, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO run_events (run_id, at, type, data_json) VALUES (?, ?, ?, ?)')
      .run(runId, at, type, JSON.stringify(data))
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original SQLite/domain failure is the actionable cause.
      }
      throw error
    }
  }
}

function validateWorkerLease(workerId: string, now: number, duration: number): void {
  if (workerId.trim() === '') throw new AutomationError('INVALID_REQUEST', 'workerId must not be empty')
  if (!Number.isSafeInteger(now) || now < 0) throw new AutomationError('INVALID_REQUEST', 'now must be a non-negative safe integer')
  if (!Number.isSafeInteger(duration) || duration < 1 || now + duration > Number.MAX_SAFE_INTEGER) {
    throw new AutomationError('INVALID_REQUEST', 'lease duration must be a positive safe integer')
  }
}

function leaseLost(claim: RunClaim): never {
  throw new AutomationError('LEASE_LOST', `worker ${claim.workerId} no longer owns ${claim.run.id} attempt ${claim.attempt}`)
}
