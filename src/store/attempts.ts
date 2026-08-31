/** Lease-fenced live Attempt lifecycle and database-level claim admission. */

import { randomUUID } from 'node:crypto'
import {
  AutomationError,
  resolveSettlement,
  type LeaseToken,
  type RunClaim,
  type RunSettlement,
  type RunView,
} from '../domain.ts'
import { decodeRun, type StoreDatabase } from './database.ts'
import type { SqlRow } from './types.ts'

export function claimNext(database: StoreDatabase, workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
  validateWorkerLease(workerId, now, leaseDurationMs)
  return database.transaction(() => {
    const row = database.sql.prepare(`
      SELECT r.* FROM runs r
      WHERE (SELECT mode FROM automation_control WHERE singleton = 1) = 'running'
        AND r.state = 'queued' AND r.available_at <= ? AND r.cancel_requested_at IS NULL AND r.attempt_count < r.max_attempts
        AND (
          r.concurrency_key IS NULL OR (
            SELECT count(*) FROM runs active
            WHERE active.concurrency_key = r.concurrency_key
              AND active.state IN ('claimed', 'running', 'cancelling')
          ) < r.concurrency_limit
        )
      ORDER BY r.priority DESC, r.available_at ASC, r.created_at ASC, r.id ASC
      LIMIT 1
    `).get(now) as SqlRow | undefined
    if (row === undefined) return undefined
    const run = decodeRun(row)
    const attempt = run.attemptCount + 1
    const token = randomUUID() as LeaseToken
    const leaseExpiresAt = now + leaseDurationMs
    const sessionId = `dsh-automation-${run.id}-a${attempt}`
    const changed = database.sql.prepare(`
      UPDATE runs SET state = 'claimed', attempt_count = ?, current_attempt = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `).run(attempt, attempt, now, run.id).changes
    if (changed !== 1) throw new AutomationError('INVALID_TRANSITION', `run ${run.id} was claimed concurrently`)
    database.sql.prepare(`
      INSERT INTO attempts (
        run_id, attempt_no, state, worker_id, lease_token, lease_expires_at, session_id, claimed_at
      ) VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?)
    `).run(run.id, attempt, workerId, token, leaseExpiresAt, sessionId, now)
    database.event(run.id, now, 'claimed', { attempt, workerId, leaseExpiresAt, sessionId })
    return { run: database.requireRun(run.id), attempt, workerId, leaseToken: token, leaseExpiresAt, sessionId }
  })
}

export function heartbeat(database: StoreDatabase, claim: RunClaim, now: number, leaseDurationMs: number): RunClaim {
  validateWorkerLease(claim.workerId, now, leaseDurationMs)
  const expires = now + leaseDurationMs
  const changed = database.sql.prepare(`
    UPDATE attempts SET lease_expires_at = ?
    WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
      AND state IN ('claimed', 'running', 'cancelling') AND lease_expires_at > ?
  `).run(expires, claim.run.id, claim.attempt, claim.leaseToken, now).changes
  if (changed !== 1) leaseLost(claim)
  return { ...claim, run: database.requireRun(claim.run.id), leaseExpiresAt: expires }
}

export function markRunning(database: StoreDatabase, claim: RunClaim, now: number): RunView {
  return database.transaction(() => {
    const attemptChanged = database.sql.prepare(`
      UPDATE attempts SET state = CASE WHEN state = 'cancelling' THEN 'cancelling' ELSE 'running' END, dispatched_at = ?
      WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
        AND state IN ('claimed', 'cancelling') AND lease_expires_at > ?
    `).run(now, claim.run.id, claim.attempt, claim.leaseToken, now).changes
    if (attemptChanged !== 1) leaseLost(claim)
    const runChanged = database.sql.prepare(`
      UPDATE runs SET state = CASE WHEN state = 'cancelling' THEN 'cancelling' ELSE 'running' END, updated_at = ?
      WHERE id = ? AND state IN ('claimed', 'cancelling') AND current_attempt = ?
    `).run(now, claim.run.id, claim.attempt).changes
    if (runChanged !== 1) leaseLost(claim)
    database.event(claim.run.id, now, 'running', { attempt: claim.attempt, sessionId: claim.sessionId })
    return database.requireRun(claim.run.id)
  })
}

export function settle(database: StoreDatabase, claim: RunClaim, settlement: RunSettlement, now: number): RunView {
  resolveSettlement(settlement)
  return database.transaction(() => {
    const current = database.currentAttempt(claim.run.id, claim.attempt)
    if (current['lease_token'] !== claim.leaseToken || Number(current['lease_expires_at']) <= now) leaseLost(claim)
    const changed = database.sql.prepare(`
      UPDATE attempts SET state = ?, finished_at = ?, outcome = ?, result_excerpt = ?, error = ?
      WHERE run_id = ? AND attempt_no = ? AND lease_token = ?
        AND state IN ('claimed', 'running', 'cancelling') AND lease_expires_at > ?
    `).run(
      settlement.state, now, settlement.outcome, settlement.resultExcerpt ?? null, settlement.error ?? null,
      claim.run.id, claim.attempt, claim.leaseToken, now,
    ).changes
    if (changed !== 1) leaseLost(claim)
    const runChanged = database.sql.prepare(`
      UPDATE runs SET state = ?, updated_at = ?, final_session_id = ?, outcome = ?, result_excerpt = ?, error = ?
      WHERE id = ? AND current_attempt = ? AND state IN ('claimed', 'running', 'cancelling')
    `).run(
      settlement.state, now, claim.sessionId, settlement.outcome, settlement.resultExcerpt ?? null,
      settlement.error ?? null, claim.run.id, claim.attempt,
    ).changes
    if (runChanged !== 1) leaseLost(claim)
    database.event(claim.run.id, now, 'settled', { attempt: claim.attempt, ...settlement })
    return database.requireRun(claim.run.id)
  })
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
