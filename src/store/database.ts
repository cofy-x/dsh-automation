/** SQLite lifecycle, schema, row decoding, and transaction primitives. */

import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AutomationError,
  decodeConcurrency,
  decodeTarget,
  decodeTrigger,
  type RunId,
  type RunOutcome,
  type RunView,
} from '../domain.ts'
import type { SqlRow, StoreOptions } from './types.ts'
import { initializeSchema } from './schema.ts'

export { SCHEMA_VERSION } from './schema.ts'

export class StoreDatabase {
  private constructor(readonly sql: DatabaseSync) {}

  static async open(options: StoreOptions): Promise<StoreDatabase> {
    const path = options.path === ':memory:' ? ':memory:' : resolve(options.path)
    if (path !== ':memory:') await preparePrivateDatabase(path)
    const sql = new DatabaseSync(path)
    try {
      sql.exec('PRAGMA foreign_keys = ON')
      sql.exec(`PRAGMA busy_timeout = ${busyTimeout(options.busyTimeoutMs)}`)
      if (path !== ':memory:') sql.exec('PRAGMA journal_mode = WAL')
      initializeSchema(sql)
      return new StoreDatabase(sql)
    } catch (error) {
      sql.close()
      throw error
    }
  }

  close(): void {
    this.sql.close()
  }

  currentAttempt(runId: RunId, attempt: number): SqlRow {
    const row = this.sql.prepare('SELECT * FROM attempts WHERE run_id = ? AND attempt_no = ?').get(runId, attempt) as SqlRow | undefined
    if (row === undefined) throw new AutomationError('INVALID_TRANSITION', `attempt ${runId}/${attempt} does not exist`)
    return row
  }

  requireRun(id: RunId): RunView {
    const row = this.sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow | undefined
    if (row === undefined) throw new AutomationError('RUN_NOT_FOUND', `run ${id} does not exist`)
    return decodeRun(row)
  }

  event(runId: RunId, at: number, type: string, data: unknown): void {
    this.sql.prepare('INSERT INTO run_events (run_id, at, type, data_json) VALUES (?, ?, ?, ?)')
      .run(runId, at, type, JSON.stringify(data))
  }

  transaction<T>(operation: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.sql.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.sql.exec('ROLLBACK')
      } catch {
        // The original SQLite/domain failure is the actionable cause.
      }
      throw error
    }
  }
}

export function decodeRun(row: SqlRow): RunView {
  const concurrency = decodeConcurrency(row['concurrency_key'], row['concurrency_limit'])
  return {
    id: row['id'] as RunId,
    state: String(row['state']) as RunView['state'],
    prompt: String(row['prompt']),
    target: decodeTarget(JSON.parse(String(row['target_json'])) as unknown),
    trigger: decodeTrigger(JSON.parse(String(row['trigger_json'])) as unknown),
    priority: Number(row['priority']),
    maxAttempts: Number(row['max_attempts']),
    attemptCount: Number(row['attempt_count']),
    ...(row['current_attempt'] === null ? {} : { currentAttempt: Number(row['current_attempt']) }),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    availableAt: Number(row['available_at']),
    ...(row['cancel_requested_at'] === null ? {} : { cancelRequestedAt: Number(row['cancel_requested_at']) }),
    ...(row['final_session_id'] === null ? {} : { finalSessionId: String(row['final_session_id']) }),
    ...(row['outcome'] === null ? {} : { outcome: String(row['outcome']) as RunOutcome }),
    ...(row['result_excerpt'] === null ? {} : { resultExcerpt: String(row['result_excerpt']) }),
    ...(row['error'] === null ? {} : { error: String(row['error']) }),
    ...(row['retry_of'] === null ? {} : { retryOf: row['retry_of'] as RunId }),
    ...(concurrency === undefined ? {} : { concurrency }),
  }
}

async function preparePrivateDatabase(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`automation database parent is not a real directory: ${parent}`)
  assertOwned(parentInfo.uid, parent)
  await chmod(parent, 0o700)
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`automation database is not a regular file: ${path}`)
    assertOwned(file.uid, path)
    await chmod(path, 0o600)
  } catch (error) {
    if (!isNotFound(error)) throw error
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  }
}

function assertOwned(owner: number, path: string): void {
  const uid = process.getuid?.()
  if (uid !== undefined && owner !== uid) throw new Error(`automation storage path is not owned by the current user: ${path}`)
}

function busyTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new AutomationError('INVALID_REQUEST', 'busyTimeoutMs must be an integer between 0 and 2147483647')
  }
  return timeout
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
