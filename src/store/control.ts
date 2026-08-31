/** Durable queue admission control shared by every Worker process. */

import { AutomationError } from '../domain.ts'
import type { StoreDatabase } from './database.ts'
import type { QueueControl, SqlRow } from './types.ts'

export function readQueueControl(database: StoreDatabase): QueueControl {
  const row = database.sql.prepare('SELECT * FROM automation_control WHERE singleton = 1').get() as SqlRow | undefined
  if (row === undefined) throw new AutomationError('STORE_INCOMPATIBLE', 'automation control row is missing')
  return decodeControl(row)
}

export function pauseQueue(database: StoreDatabase, now: number, reason?: string): QueueControl {
  validNow(now)
  if (reason !== undefined && (reason.trim() === '' || reason.length > 500)) {
    throw new AutomationError('INVALID_REQUEST', 'pause reason must be between 1 and 500 characters')
  }
  database.sql.prepare(`
    UPDATE automation_control SET mode = 'paused', paused_at = COALESCE(paused_at, ?), pause_reason = ?, updated_at = ? WHERE singleton = 1
  `).run(now, reason ?? null, now)
  return readQueueControl(database)
}

export function drainQueue(database: StoreDatabase, now: number, reason?: string): QueueControl {
  validNow(now)
  if (reason !== undefined && (reason.trim() === '' || reason.length > 500)) {
    throw new AutomationError('INVALID_REQUEST', 'drain reason must be between 1 and 500 characters')
  }
  database.sql.prepare(`
    UPDATE automation_control SET mode = 'draining', paused_at = COALESCE(paused_at, ?), pause_reason = ?, updated_at = ? WHERE singleton = 1
  `).run(now, reason ?? null, now)
  return readQueueControl(database)
}

export function resumeQueue(database: StoreDatabase, now: number): QueueControl {
  validNow(now)
  database.sql.prepare(`
    UPDATE automation_control SET mode = 'running', paused_at = NULL, pause_reason = NULL, updated_at = ? WHERE singleton = 1
  `).run(now)
  return readQueueControl(database)
}

function decodeControl(row: SqlRow): QueueControl {
  const pausedAt = row['paused_at'] === null ? undefined : Number(row['paused_at'])
  const reason = row['pause_reason'] === null ? undefined : String(row['pause_reason'])
  return {
    mode: String(row['mode']) as QueueControl['mode'],
    paused: pausedAt !== undefined,
    updatedAt: Number(row['updated_at']),
    ...(pausedAt === undefined ? {} : { pausedAt }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function validNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new AutomationError('INVALID_REQUEST', 'now must be a non-negative safe integer')
}
