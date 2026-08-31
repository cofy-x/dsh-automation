/** Cursor-paginated Run reads and durable global event feed. */

import { AutomationError, type RunState } from '../domain.ts'
import type { SQLInputValue } from 'node:sqlite'
import { decodeRun, type StoreDatabase } from './database.ts'
import type { EventPage, EventQuery, RunEvent, RunPage, RunQuery, SqlRow } from './types.ts'

const RUN_STATES = new Set<RunState>([
  'queued', 'claimed', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'indeterminate',
])

export function queryRuns(database: StoreDatabase, query: RunQuery = {}): RunPage {
  const limit = pageLimit(query.limit)
  const clauses: string[] = []
  const values: SQLInputValue[] = []
  if (query.states !== undefined) {
    if (query.states.length === 0 || query.states.some(state => !RUN_STATES.has(state))) invalid('states must contain known Run states')
    clauses.push(`state IN (${query.states.map(() => '?').join(', ')})`)
    values.push(...query.states)
  }
  addTriggerFilter(clauses, values, query.triggerKind, query.triggerSourceId)
  if (query.before !== undefined) {
    if (!Number.isSafeInteger(query.before.createdAt) || query.before.createdAt < 0 || query.before.id === '') invalid('invalid Run cursor')
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
    values.push(query.before.createdAt, query.before.createdAt, query.before.id)
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  const rows = database.sql.prepare(`
    SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(...values, limit + 1) as SqlRow[]
  const hasMore = rows.length > limit
  const runs = rows.slice(0, limit).map(decodeRun)
  const last = runs.at(-1)
  return {
    runs,
    hasMore,
    ...(hasMore && last !== undefined ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
  }
}

export function queryEvents(database: StoreDatabase, query: EventQuery = {}): EventPage {
  const limit = pageLimit(query.limit)
  const afterSeq = query.afterSeq ?? 0
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) invalid('afterSeq must be a non-negative safe integer')
  const oldestAvailableSeq = Number((database.sql.prepare('SELECT coalesce(min(seq), 0) AS seq FROM run_events').get() as SqlRow)['seq'])
  const prunedThroughSeq = Number((database.sql.prepare('SELECT pruned_through_seq FROM event_retention WHERE singleton = 1').get() as SqlRow)['pruned_through_seq'])
  if (afterSeq < prunedThroughSeq) {
    throw new AutomationError('EVENT_CURSOR_EXPIRED', `event cursor ${afterSeq} is at or before pruned sequence ${prunedThroughSeq}`)
  }
  if (query.runId !== undefined) {
    if (query.runId === '') invalid('runId must not be empty')
  }
  const validationClauses: string[] = []
  const validationValues: SQLInputValue[] = []
  addTriggerFilter(validationClauses, validationValues, query.triggerKind, query.triggerSourceId)
  const rows = database.sql.prepare(`
    SELECT e.*, r.trigger_kind AS event_trigger_kind, r.trigger_source_id AS event_trigger_source_id
    FROM run_events e JOIN runs r ON r.id = e.run_id
    WHERE e.seq > ? ORDER BY e.seq ASC LIMIT ?
  `).all(afterSeq, limit + 1) as SqlRow[]
  const hasMore = rows.length > limit
  const scanned = rows.slice(0, limit)
  const events = scanned
    .filter(row => query.runId === undefined || row['run_id'] === query.runId)
    .filter(row => query.triggerKind === undefined || row['event_trigger_kind'] === query.triggerKind)
    .filter(row => query.triggerSourceId === undefined || row['event_trigger_source_id'] === query.triggerSourceId)
    .map(decodeEvent)
  return {
    events,
    oldestAvailableSeq,
    prunedThroughSeq,
    nextSeq: scanned.at(-1) === undefined ? afterSeq : Number(scanned.at(-1)!['seq']),
    hasMore,
  }
}

function addTriggerFilter(
  clauses: string[],
  values: SQLInputValue[],
  kind: string | undefined,
  sourceId: string | undefined,
  prefix = '',
): void {
  if (kind !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) invalid('invalid trigger kind filter')
    clauses.push(`${prefix}trigger_kind = ?`)
    values.push(kind)
  }
  if (sourceId !== undefined) {
    if (sourceId.trim() === '' || sourceId.length > 256) invalid('invalid trigger source filter')
    clauses.push(`${prefix}trigger_source_id = ?`)
    values.push(sourceId)
  }
}

function decodeEvent(row: SqlRow): RunEvent {
  return {
    seq: Number(row['seq']),
    runId: row['run_id'] as RunEvent['runId'],
    at: Number(row['at']),
    type: String(row['type']),
    data: JSON.parse(String(row['data_json'])) as unknown,
  }
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid('limit must be an integer between 1 and 200')
  return limit
}

function invalid(message: string): never {
  throw new AutomationError('INVALID_REQUEST', message)
}
