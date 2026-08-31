/** Lease-expiry transitions and recovery ownership fencing. */

import { randomUUID } from 'node:crypto'
import { AutomationError, type LeaseToken, type RunClaim, type RunId, type RunSettlement, type RunView } from '../domain.ts'
import type { StoreDatabase } from './database.ts'
import type { ExpiredAttempt, SqlRow } from './types.ts'

export function recoverUndispatchedExpired(database: StoreDatabase, now: number): RunId[] {
  return database.transaction(() => {
    const rows = database.sql.prepare(`
      SELECT a.run_id, a.attempt_no, r.max_attempts
      FROM attempts a JOIN runs r ON r.id = a.run_id AND r.current_attempt = a.attempt_no
      WHERE r.state IN ('claimed', 'cancelling') AND a.state IN ('claimed', 'cancelling')
        AND a.dispatched_at IS NULL AND a.lease_expires_at <= ?
    `).all(now) as SqlRow[]
    const recovered: RunId[] = []
    for (const row of rows) {
      const runId = row['run_id'] as RunId
      const attempt = Number(row['attempt_no'])
      const exhausted = attempt >= Number(row['max_attempts'])
      database.sql.prepare(`
        UPDATE attempts SET state = 'lost', finished_at = ?, outcome = 'not-dispatched', error = 'worker lease expired before durable dispatch'
        WHERE run_id = ? AND attempt_no = ? AND dispatched_at IS NULL AND lease_expires_at <= ?
      `).run(now, runId, attempt, now)
      database.sql.prepare(`
        UPDATE runs SET state = ?, updated_at = ?, current_attempt = NULL, outcome = ?, error = ?
        WHERE id = ? AND current_attempt = ? AND state IN ('claimed', 'cancelling')
      `).run(
        exhausted ? 'failed' : 'queued',
        now,
        exhausted ? 'not-dispatched' : null,
        exhausted ? 'all Attempts were lost before durable dispatch' : null,
        runId,
        attempt,
      )
      database.event(runId, now, exhausted ? 'failed' : 'requeued', { attempt, reason: 'lease-expired-before-dispatch' })
      recovered.push(runId)
    }
    return recovered
  })
}

export function expiredDispatched(database: StoreDatabase, now: number): ExpiredAttempt[] {
  const rows = database.sql.prepare(`
    SELECT a.run_id, a.attempt_no, a.session_id
    FROM attempts a JOIN runs r ON r.id = a.run_id AND r.current_attempt = a.attempt_no
    WHERE r.state IN ('running', 'cancelling') AND a.dispatched_at IS NOT NULL AND a.lease_expires_at <= ?
    ORDER BY a.lease_expires_at ASC, a.run_id ASC
  `).all(now) as SqlRow[]
  return rows.map(row => ({
    runId: row['run_id'] as RunId,
    attempt: Number(row['attempt_no']),
    sessionId: String(row['session_id']),
  }))
}

export function reclaimDispatched(
  database: StoreDatabase,
  ref: ExpiredAttempt,
  workerId: string,
  now: number,
  leaseDurationMs: number,
): RunClaim | undefined {
  validateWorkerLease(workerId, now, leaseDurationMs)
  return database.transaction(() => {
    const token = randomUUID() as LeaseToken
    const leaseExpiresAt = now + leaseDurationMs
    const changed = database.sql.prepare(`
      UPDATE attempts SET worker_id = ?, lease_token = ?, lease_expires_at = ?
      WHERE run_id = ? AND attempt_no = ? AND session_id = ?
        AND state IN ('running', 'cancelling') AND dispatched_at IS NOT NULL
        AND lease_expires_at <= ?
    `).run(workerId, token, leaseExpiresAt, ref.runId, ref.attempt, ref.sessionId, now).changes
    if (changed !== 1) return undefined
    const run = database.requireRun(ref.runId)
    if (run.currentAttempt !== ref.attempt || (run.state !== 'running' && run.state !== 'cancelling')) {
      throw new AutomationError('INVALID_TRANSITION', `run ${ref.runId} no longer owns attempt ${ref.attempt}`)
    }
    database.event(ref.runId, now, 'recovered-claim', { attempt: ref.attempt, workerId, leaseExpiresAt })
    return { run, attempt: ref.attempt, workerId, leaseToken: token, leaseExpiresAt, sessionId: ref.sessionId }
  })
}

export function settleExpired(database: StoreDatabase, ref: ExpiredAttempt, settlement: RunSettlement, now: number): RunView {
  return database.transaction(() => {
    const changed = database.sql.prepare(`
      UPDATE attempts SET state = ?, finished_at = ?, outcome = ?, result_excerpt = ?, error = ?
      WHERE run_id = ? AND attempt_no = ? AND state IN ('running', 'cancelling') AND lease_expires_at <= ?
    `).run(
      settlement.state,
      now,
      settlement.outcome,
      settlement.resultExcerpt ?? null,
      settlement.error ?? null,
      ref.runId,
      ref.attempt,
      now,
    ).changes
    if (changed !== 1) throw new AutomationError('INVALID_TRANSITION', `attempt ${ref.runId}/${ref.attempt} is not expired and dispatched`)
    database.sql.prepare(`
      UPDATE runs SET state = ?, updated_at = ?, final_session_id = ?, outcome = ?, result_excerpt = ?, error = ?
      WHERE id = ? AND current_attempt = ? AND state IN ('running', 'cancelling')
    `).run(
      settlement.state,
      now,
      ref.sessionId,
      settlement.outcome,
      settlement.resultExcerpt ?? null,
      settlement.error ?? null,
      ref.runId,
      ref.attempt,
    )
    database.event(ref.runId, now, 'recovered-settlement', { attempt: ref.attempt, ...settlement })
    return database.requireRun(ref.runId)
  })
}

function validateWorkerLease(workerId: string, now: number, duration: number): void {
  if (workerId.trim() === '') throw new AutomationError('INVALID_REQUEST', 'workerId must not be empty')
  if (!Number.isSafeInteger(now) || now < 0) throw new AutomationError('INVALID_REQUEST', 'now must be a non-negative safe integer')
  if (!Number.isSafeInteger(duration) || duration < 1 || now + duration > Number.MAX_SAFE_INTEGER) {
    throw new AutomationError('INVALID_REQUEST', 'lease duration must be a positive safe integer')
  }
}
