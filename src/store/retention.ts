/** Durable event-consumer checkpoints and bounded terminal Run retention. */

import { AutomationError, type RunId } from '../domain.ts'
import type { StoreDatabase } from './database.ts'
import type { EventConsumer, PurgeResult, SqlRow } from './types.ts'

export function checkpointConsumer(database: StoreDatabase, id: string, seq: number, now: number): EventConsumer {
  validConsumer(id)
  validInteger(seq, 'event sequence')
  validInteger(now, 'now')
  return database.transaction(() => {
    const newest = Number((database.sql.prepare(`
      SELECT max(seq) AS seq FROM (
        SELECT coalesce(max(seq), 0) AS seq FROM run_events
        UNION ALL SELECT pruned_through_seq AS seq FROM event_retention WHERE singleton = 1
      )
    `).get() as SqlRow)['seq'])
    if (seq > newest) throw new AutomationError('INVALID_REQUEST', `event sequence ${seq} is beyond newest sequence ${newest}`)
    const current = database.sql.prepare('SELECT last_seq FROM event_consumers WHERE consumer_id = ?').get(id) as SqlRow | undefined
    if (current !== undefined && seq < Number(current['last_seq'])) {
      throw new AutomationError('INVALID_TRANSITION', `event consumer ${id} cannot move backwards`)
    }
    database.sql.prepare(`
      INSERT INTO event_consumers (consumer_id, last_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(consumer_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
    `).run(id, seq, now)
    return { id, lastSeq: seq, updatedAt: now }
  })
}

export function listConsumers(database: StoreDatabase): EventConsumer[] {
  return (database.sql.prepare('SELECT * FROM event_consumers ORDER BY consumer_id').all() as SqlRow[]).map(row => ({
    id: String(row['consumer_id']), lastSeq: Number(row['last_seq']), updatedAt: Number(row['updated_at']),
  }))
}

export function removeConsumer(database: StoreDatabase, id: string): boolean {
  validConsumer(id)
  return database.sql.prepare('DELETE FROM event_consumers WHERE consumer_id = ?').run(id).changes === 1
}

export function purgeTerminal(database: StoreDatabase, before: number, limit: number): PurgeResult {
  validInteger(before, 'purge cutoff')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AutomationError('INVALID_REQUEST', 'purge limit must be an integer between 1 and 1000')
  }
  return database.transaction(() => {
    const consumer = database.sql.prepare('SELECT min(last_seq) AS floor FROM event_consumers').get() as SqlRow
    const floor = consumer['floor'] === null ? undefined : Number(consumer['floor'])
    const rows = database.sql.prepare(`
      SELECT r.id FROM runs r
      WHERE r.state IN ('succeeded', 'failed', 'cancelled', 'indeterminate') AND r.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.retry_of = r.id)
        AND (? IS NULL OR coalesce((SELECT max(e.seq) FROM run_events e WHERE e.run_id = r.id), 0) <= ?)
      ORDER BY r.updated_at ASC, r.id ASC LIMIT ?
    `).all(before, floor ?? null, floor ?? null, limit) as SqlRow[]
    const ids = rows.map(row => row['id'] as RunId)
    const removeEvents = database.sql.prepare('DELETE FROM run_events WHERE run_id = ?')
    const removeAttempts = database.sql.prepare('DELETE FROM attempts WHERE run_id = ?')
    const removeRun = database.sql.prepare('DELETE FROM runs WHERE id = ?')
    for (const id of ids) {
      const event = database.sql.prepare('SELECT coalesce(max(seq), 0) AS seq FROM run_events WHERE run_id = ?').get(id) as SqlRow
      database.sql.prepare(`
        UPDATE event_retention SET pruned_through_seq = max(pruned_through_seq, ?) WHERE singleton = 1
      `).run(Number(event['seq']))
      removeEvents.run(id)
      removeAttempts.run(id)
      removeRun.run(id)
    }
    return { purgedRunIds: ids, ...(floor === undefined ? {} : { protectedByEventSeq: floor }) }
  })
}

function validConsumer(id: string): void {
  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(id)) throw new AutomationError('INVALID_REQUEST', 'invalid event consumer id')
}

function validInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new AutomationError('INVALID_REQUEST', `${name} must be a non-negative safe integer`)
}
