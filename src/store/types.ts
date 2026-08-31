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

/** Stable newest-first cursor for bounded Run queries. */
export interface RunCursor {
  readonly createdAt: number
  readonly id: RunId
}

/** Bounded Run query used by operators and Trigger reconciliation. */
export interface RunQuery {
  readonly states?: readonly RunState[]
  readonly triggerKind?: string
  readonly triggerSourceId?: string
  readonly before?: RunCursor
  readonly limit?: number
}

export interface RunPage {
  readonly runs: readonly import('../domain.ts').RunView[]
  readonly nextCursor?: RunCursor
  readonly hasMore: boolean
}

/** Forward-only global scan query; filters select output without stalling the scan cursor. */
export interface EventQuery {
  readonly afterSeq?: number
  readonly runId?: RunId
  readonly triggerKind?: string
  readonly triggerSourceId?: string
  readonly limit?: number
}

export interface EventPage {
  readonly events: readonly RunEvent[]
  readonly oldestAvailableSeq: number
  readonly prunedThroughSeq: number
  readonly nextSeq: number
  readonly hasMore: boolean
}

export interface EventConsumer {
  readonly id: string
  readonly lastSeq: number
  readonly updatedAt: number
}

export interface PurgeResult {
  readonly purgedRunIds: readonly RunId[]
  readonly protectedByEventSeq?: number
}

/** Durable queue admission state. Active Attempts continue while paused. */
export interface QueueControl {
  readonly mode: 'running' | 'paused' | 'draining'
  readonly paused: boolean
  readonly pausedAt?: number
  readonly reason?: string
  readonly updatedAt: number
}

/** Explicit operator retry policy; indeterminate work requires acknowledgement. */
export interface RetryOptions {
  readonly idempotencyKey: string
  readonly confirmIndeterminate?: boolean
  readonly priority?: number
  readonly maxAttempts?: number
}

/** Store and queue health projection for operators and supervisors. */
export interface AutomationStatus {
  readonly health: 'ok' | 'degraded'
  readonly schemaVersion: number
  readonly checkedAt: number
  readonly runs: Readonly<Record<RunState, number>>
  readonly queued: { readonly count: number; readonly oldestCreatedAt?: number }
  readonly active: number
  readonly expired: { readonly undispatched: number; readonly dispatched: number }
  readonly workers: readonly {
    readonly workerId: string
    readonly activeAttempts: number
    readonly oldestLeaseExpiresAt: number
  }[]
  readonly eventFeed: { readonly newestSeq: number; readonly prunedThroughSeq: number; readonly consumers: number }
  readonly control: QueueControl
}
