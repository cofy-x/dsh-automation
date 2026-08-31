/** Run submission, management reads, health, cancellation, and audit queries. */

import { randomUUID } from 'node:crypto'
import {
  AutomationError,
  resolveSubmitRequest,
  type RunId,
  type RunState,
  type RunView,
  type SubmitRunRequest,
} from '../domain.ts'
import { decodeRun, SCHEMA_VERSION, type StoreDatabase } from './database.ts'
import type { AutomationStatus, RunEvent, SqlRow } from './types.ts'

export function submitRun(database: StoreDatabase, request: SubmitRunRequest, now: number): { readonly run: RunView; readonly created: boolean } {
  const resolved = resolveSubmitRequest(request, now)
  return database.transaction(() => {
    const key = resolved.trigger.idempotencyKey
    if (key !== undefined) {
      const existing = database.sql.prepare(`
        SELECT * FROM runs WHERE trigger_kind = ? AND trigger_source_id = ? AND idempotency_key = ?
      `).get(resolved.trigger.kind, resolved.trigger.sourceId, key) as SqlRow | undefined
      if (existing !== undefined) return { run: decodeRun(existing), created: false }
    }
    const id = `run-${randomUUID()}` as RunId
    database.sql.prepare(`
      INSERT INTO runs (
        id, state, prompt, target_json, trigger_json, trigger_kind, trigger_source_id,
        idempotency_key, priority, max_attempts, attempt_count, created_at, updated_at,
        available_at, retry_of
      ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      resolved.prompt,
      JSON.stringify(resolved.target),
      JSON.stringify(resolved.trigger),
      resolved.trigger.kind,
      resolved.trigger.sourceId,
      key ?? null,
      resolved.priority,
      resolved.maxAttempts,
      now,
      now,
      resolved.availableAt,
      resolved.retryOf ?? null,
    )
    database.event(id, now, 'submitted', { trigger: resolved.trigger })
    return { run: database.requireRun(id), created: true }
  })
}

export function listRuns(database: StoreDatabase, state?: RunState): RunView[] {
  const rows = state === undefined
    ? database.sql.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all()
    : database.sql.prepare('SELECT * FROM runs WHERE state = ? ORDER BY created_at DESC, id DESC').all(state)
  return rows.map(row => decodeRun(row as SqlRow))
}

export function automationStatus(database: StoreDatabase, now: number): AutomationStatus {
  if (!Number.isSafeInteger(now) || now < 0) throw new AutomationError('INVALID_REQUEST', 'now must be a non-negative safe integer')
  const states: RunState[] = ['queued', 'claimed', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'indeterminate']
  const runs = Object.fromEntries(states.map(state => [state, 0])) as Record<RunState, number>
  for (const row of database.sql.prepare('SELECT state, count(*) AS count FROM runs GROUP BY state').all() as SqlRow[]) {
    runs[String(row['state']) as RunState] = Number(row['count'])
  }
  const queued = database.sql.prepare(`
    SELECT count(*) AS count, min(created_at) AS oldest_created_at FROM runs WHERE state = 'queued'
  `).get() as SqlRow
  const expired = database.sql.prepare(`
    SELECT
      sum(CASE WHEN dispatched_at IS NULL THEN 1 ELSE 0 END) AS undispatched,
      sum(CASE WHEN dispatched_at IS NOT NULL THEN 1 ELSE 0 END) AS dispatched
    FROM attempts WHERE state IN ('claimed', 'running', 'cancelling') AND lease_expires_at <= ?
  `).get(now) as SqlRow
  const oldestCreatedAt = queued['oldest_created_at'] === null ? undefined : Number(queued['oldest_created_at'])
  return {
    health: 'ok',
    schemaVersion: SCHEMA_VERSION,
    checkedAt: now,
    runs,
    queued: { count: Number(queued['count']), ...(oldestCreatedAt === undefined ? {} : { oldestCreatedAt }) },
    active: runs.claimed + runs.running + runs.cancelling,
    expired: {
      undispatched: Number(expired['undispatched'] ?? 0),
      dispatched: Number(expired['dispatched'] ?? 0),
    },
  }
}

export function requestRunCancel(database: StoreDatabase, id: RunId, now: number): RunView {
  return database.transaction(() => {
    const run = database.requireRun(id)
    if (terminal(run.state)) return run
    if (run.state === 'queued') {
      database.sql.prepare(`
        UPDATE runs SET state = 'cancelled', cancel_requested_at = ?, updated_at = ?, outcome = 'cancelled'
        WHERE id = ? AND state = 'queued'
      `).run(now, now, id)
      database.event(id, now, 'cancelled', { beforeDispatch: true })
    } else {
      database.sql.prepare(`
        UPDATE runs SET state = 'cancelling', cancel_requested_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('claimed', 'running')
      `).run(now, now, id)
      database.sql.prepare(`
        UPDATE attempts SET state = 'cancelling'
        WHERE run_id = ? AND attempt_no = ? AND state IN ('claimed', 'running')
      `).run(id, run.currentAttempt as number)
      database.event(id, now, 'cancel-requested', { attempt: run.currentAttempt })
    }
    return database.requireRun(id)
  })
}

export function runEvents(database: StoreDatabase, id: RunId): RunEvent[] {
  database.requireRun(id)
  return (database.sql.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(id) as SqlRow[]).map(row => ({
    seq: Number(row['seq']),
    runId: row['run_id'] as RunId,
    at: Number(row['at']),
    type: String(row['type']),
    data: JSON.parse(String(row['data_json'])) as unknown,
  }))
}

function terminal(state: RunState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'indeterminate'
}
