/** Public persistence projections and internal row shapes. */

import type { RunId, RunState } from '../domain.ts'

export interface StoreOptions {
  readonly path: string
  readonly busyTimeoutMs?: number
}

export interface SqlRow extends Record<string, unknown> {}

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

/** Store and queue health projection for operators and supervisors. */
export interface AutomationStatus {
  readonly health: 'ok'
  readonly schemaVersion: number
  readonly checkedAt: number
  readonly runs: Readonly<Record<RunState, number>>
  readonly queued: { readonly count: number; readonly oldestCreatedAt?: number }
  readonly active: number
  readonly expired: { readonly undispatched: number; readonly dispatched: number }
}
