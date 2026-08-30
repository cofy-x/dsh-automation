/** SQLite WAL persistence and transactional Run state transitions. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AutomationError,
  decodeTarget,
  decodeTrigger,
  resolveSubmitRequest,
  type LeaseToken,
  type RunClaim,
  type RunId,
  type RunOutcome,
  type RunSettlement,
  type RunState,
  type RunView,
  type SubmitRunRequest,
} from './domain.ts'

/** Current on-disk schema. Pre-release readers reject every other version. */
export const SCHEMA_VERSION = 1

interface StoreOptions {
  readonly path: string
  readonly busyTimeoutMs?: number
}

interface SqlRow extends Record<string, unknown> {}

/** Expired dispatched Attempt that requires canonical Session recovery. */
export interface ExpiredAttempt {
  readonly runId: RunId
  readonly attempt: number
  readonly sessionId: string
}

/** One append-only audit record. */
export interface RunEvent {
  readonly seq: number
  readonly runId: RunId
  readonly at: number
  readonly type: string
  readonly data: unknown
}

/** Durable store shared by management processes and one or more local Workers. */
export class AutomationStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Validate the path, open SQLite, and initialize or verify schema v1. */
  static async open(options: StoreOptions): Promise<AutomationStore> {
    const path = options.path === ':memory:' ? ':memory:' : resolve(options.path)
    if (path !== ':memory:') await preparePrivateDatabase(path)
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`PRAGMA busy_timeout = ${busyTimeout(options.busyTimeoutMs)}`)
      if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
      initializeSchema(db)
      return new AutomationStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Close this process's SQLite connection. */
  close(): void {
    this.db.close()
  }

  /** Submit one immutable Run, returning the existing Run for a duplicate idempotency key. */
  submit(request: SubmitRunRequest, now = Date.now()): { readonly run: RunView; readonly created: boolean } {
    const resolved = resolveSubmitRequest(request, now)
    return this.transaction(() => {
      const key = resolved.trigger.idempotencyKey
      if (key !== undefined) {
        const existing = this.db.prepare(`
          SELECT * FROM runs WHERE trigger_kind = ? AND trigger_source_id = ? AND idempotency_key = ?
        `).get(resolved.trigger.kind, resolved.trigger.sourceId, key) as SqlRow | undefined
        if (existing !== undefined) return { run: decodeRun(existing), created: false }
      }
      const id = `run-${randomUUID()}` as RunId
      this.db.prepare(`
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
      this.event(id, now, 'submitted', { trigger: resolved.trigger })
      return { run: this.requireRun(id), created: true }
    })
  }

  /** Return one Run by id. */
  get(id: RunId): RunView {
    return this.requireRun(id)
  }

  /** List Runs newest-first, optionally restricted to one state. */
  list(state?: RunState): RunView[] {
    const rows = state === undefined
      ? this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all()
      : this.db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY created_at DESC, id DESC').all(state)
    return rows.map(row => decodeRun(row as SqlRow))
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
    return this.transaction(() => {
      const run = this.requireRun(id)
      if (terminal(run.state)) return run
      if (run.state === 'queued') {
        this.db.prepare(`
          UPDATE runs SET state = 'cancelled', cancel_requested_at = ?, updated_at = ?, outcome = 'cancelled'
          WHERE id = ? AND state = 'queued'
        `).run(now, now, id)
        this.event(id, now, 'cancelled', { beforeDispatch: true })
      } else {
        this.db.prepare(`
          UPDATE runs SET state = 'cancelling', cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('claimed', 'running')
        `).run(now, now, id)
        this.db.prepare(`
          UPDATE attempts SET state = 'cancelling'
          WHERE run_id = ? AND attempt_no = ? AND state IN ('claimed', 'running')
        `).run(id, run.currentAttempt as number)
        this.event(id, now, 'cancel-requested', { attempt: run.currentAttempt })
      }
      return this.requireRun(id)
    })
  }

  /** Requeue expired claims that provably never crossed the durable dispatch checkpoint. */
  recoverUndispatchedExpired(now: number): RunId[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
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
        this.db.prepare(`
          UPDATE attempts SET state = 'lost', finished_at = ?, outcome = 'not-dispatched', error = 'worker lease expired before durable dispatch'
          WHERE run_id = ? AND attempt_no = ? AND dispatched_at IS NULL AND lease_expires_at <= ?
        `).run(now, runId, attempt, now)
        this.db.prepare(`
          UPDATE runs SET state = ?, updated_at = ?, current_attempt = NULL,
            outcome = ?, error = ?
          WHERE id = ? AND current_attempt = ? AND state IN ('claimed', 'cancelling')
        `).run(
          exhausted ? 'failed' : 'queued',
          now,
          exhausted ? 'not-dispatched' : null,
          exhausted ? 'all Attempts were lost before durable dispatch' : null,
          runId,
          attempt,
        )
        this.event(runId, now, exhausted ? 'failed' : 'requeued', { attempt, reason: 'lease-expired-before-dispatch' })
        recovered.push(runId)
      }
      return recovered
    })
  }

  /** List expired dispatched Attempts that require canonical Session inspection. */
  expiredDispatched(now: number): ExpiredAttempt[] {
    const rows = this.db.prepare(`
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

  /** Fence and take ownership of an expired dispatched Attempt for safe pre-turn resume. */
  reclaimDispatched(ref: ExpiredAttempt, workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    validateWorkerLease(workerId, now, leaseDurationMs)
    return this.transaction(() => {
      const token = randomUUID() as LeaseToken
      const leaseExpiresAt = now + leaseDurationMs
      const changed = this.db.prepare(`
        UPDATE attempts SET worker_id = ?, lease_token = ?, lease_expires_at = ?
        WHERE run_id = ? AND attempt_no = ? AND session_id = ?
          AND state IN ('running', 'cancelling') AND dispatched_at IS NOT NULL
          AND lease_expires_at <= ?
      `).run(workerId, token, leaseExpiresAt, ref.runId, ref.attempt, ref.sessionId, now).changes
      if (changed !== 1) return undefined
      const run = this.requireRun(ref.runId)
      if (run.currentAttempt !== ref.attempt || (run.state !== 'running' && run.state !== 'cancelling')) {
        throw new AutomationError('INVALID_TRANSITION', `run ${ref.runId} no longer owns attempt ${ref.attempt}`)
      }
      this.event(ref.runId, now, 'recovered-claim', { attempt: ref.attempt, workerId, leaseExpiresAt })
      return {
        run,
        attempt: ref.attempt,
        workerId,
        leaseToken: token,
        leaseExpiresAt,
        sessionId: ref.sessionId,
      }
    })
  }

  /** Settle an expired dispatched Attempt from canonical Session recovery evidence. */
  settleExpired(ref: ExpiredAttempt, settlement: RunSettlement, now: number): RunView {
    return this.transaction(() => {
      const changed = this.db.prepare(`
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
      this.db.prepare(`
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
      this.event(ref.runId, now, 'recovered-settlement', { attempt: ref.attempt, ...settlement })
      return this.requireRun(ref.runId)
    })
  }

  /** Settle an expired dispatched Attempt whose canonical outcome is unknowable. */
  settleExpiredIndeterminate(ref: ExpiredAttempt, diagnostic: string, now: number): RunView {
    return this.settleExpired(ref, { state: 'indeterminate', outcome: 'interrupted', error: diagnostic }, now)
  }

  /** Read the append-only audit stream for one Run. */
  events(id: RunId): RunEvent[] {
    this.requireRun(id)
    return (this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(id) as SqlRow[]).map(row => ({
      seq: Number(row['seq']),
      runId: row['run_id'] as RunId,
      at: Number(row['at']),
      type: String(row['type']),
      data: JSON.parse(String(row['data_json'])) as unknown,
    }))
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

function initializeSchema(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new AutomationError('STORE_INCOMPATIBLE', `automation store schema ${version} is not supported by schema ${SCHEMA_VERSION}`)
  }
  if (version === SCHEMA_VERSION) return
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE store_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      store_id TEXT NOT NULL
    ) STRICT;
    INSERT INTO store_meta VALUES (1, ${SCHEMA_VERSION}, '${randomUUID()}');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('queued','claimed','running','cancelling','succeeded','failed','cancelled','indeterminate')),
      prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
      target_json TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      trigger_source_id TEXT NOT NULL,
      idempotency_key TEXT,
      priority INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      current_attempt INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL,
      cancel_requested_at INTEGER,
      final_session_id TEXT,
      outcome TEXT,
      result_excerpt TEXT,
      error TEXT,
      retry_of TEXT REFERENCES runs(id)
    ) STRICT;
    CREATE UNIQUE INDEX runs_idempotency ON runs(trigger_kind, trigger_source_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX runs_claim_order ON runs(state, available_at, priority DESC, created_at, id);
    CREATE TABLE attempts (
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      state TEXT NOT NULL CHECK (state IN ('claimed','running','cancelling','succeeded','failed','cancelled','lost','indeterminate')),
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      lease_expires_at INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      finished_at INTEGER,
      outcome TEXT,
      result_excerpt TEXT,
      error TEXT,
      PRIMARY KEY (run_id, attempt_no)
    ) STRICT;
    CREATE INDEX attempts_expired ON attempts(state, lease_expires_at);
    CREATE TABLE run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX run_events_by_run ON run_events(run_id, seq);
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `)
}

function decodeRun(row: SqlRow): RunView {
  const state = String(row['state']) as RunState
  const target = decodeTarget(JSON.parse(String(row['target_json'])) as unknown)
  const trigger = decodeTrigger(JSON.parse(String(row['trigger_json'])) as unknown)
  return {
    id: row['id'] as RunId,
    state,
    prompt: String(row['prompt']),
    target,
    trigger,
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

function validateWorkerLease(workerId: string, now: number, duration: number): void {
  if (workerId.trim() === '') throw new AutomationError('INVALID_REQUEST', 'workerId must not be empty')
  if (!Number.isSafeInteger(now) || now < 0) throw new AutomationError('INVALID_REQUEST', 'now must be a non-negative safe integer')
  if (!Number.isSafeInteger(duration) || duration < 1 || now + duration > Number.MAX_SAFE_INTEGER) {
    throw new AutomationError('INVALID_REQUEST', 'lease duration must be a positive safe integer')
  }
}

function terminal(state: RunState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'indeterminate'
}

function leaseLost(claim: RunClaim): never {
  throw new AutomationError('LEASE_LOST', `worker ${claim.workerId} no longer owns ${claim.run.id} attempt ${claim.attempt}`)
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
