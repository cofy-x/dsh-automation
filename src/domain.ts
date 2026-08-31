/** Durable, transport-safe automation domain types. */

import { isAbsolute } from 'node:path'

declare const runIdBrand: unique symbol
declare const leaseTokenBrand: unique symbol

/** Stable identifier of one durable automation Run. */
export type RunId = string & { readonly [runIdBrand]: 'RunId' }

/** Unforgeable capability fencing writes from an expired Worker Attempt. */
export type LeaseToken = string & { readonly [leaseTokenBrand]: 'LeaseToken' }

/** Current lifecycle state of a durable Run. */
export type RunState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

/** Current lifecycle state of one concrete execution Attempt. */
export type AttemptState = 'claimed' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'lost' | 'indeterminate'

/** Normalized reason derived from a canonical DSH turn or recovery decision. */
export type RunOutcome = 'completed' | 'blocked' | 'max-tokens' | 'error' | 'aborted' | 'cancelled' | 'interrupted' | 'not-dispatched'

/** Trigger provenance used for audit and idempotent submission. */
export interface TriggerSpec {
  /** Stable lowercase adapter namespace such as manual, cron, or webhook. */
  readonly kind: string
  readonly sourceId: string
  readonly occurrenceId?: string
  readonly idempotencyKey?: string
}

/** Optional database-enforced admission group shared across Worker processes. */
export interface ConcurrencySpec {
  readonly key: string
  readonly limit: number
}

/** A fresh canonical DSH Session target. */
export interface FreshTarget {
  readonly kind: 'fresh'
  readonly cwd: string
  readonly preset?: string
  readonly provider?: string
  readonly model?: string
  readonly permissionPreset?: string
}

/** Target accepted by the first automation release. */
export type TargetSpec = FreshTarget

/** Request accepted by the durable submission boundary. */
export interface SubmitRunRequest {
  readonly prompt: string
  readonly target: TargetSpec
  readonly trigger: TriggerSpec
  readonly priority?: number
  readonly availableAt?: number
  readonly maxAttempts?: number
  readonly retryOf?: RunId
  readonly concurrency?: ConcurrencySpec
}

/** Read-only public projection of one Run. */
export interface RunView {
  readonly id: RunId
  readonly state: RunState
  readonly prompt: string
  readonly target: TargetSpec
  readonly trigger: TriggerSpec
  readonly priority: number
  readonly maxAttempts: number
  readonly attemptCount: number
  readonly currentAttempt?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly availableAt: number
  readonly cancelRequestedAt?: number
  readonly finalSessionId?: string
  readonly outcome?: RunOutcome
  readonly resultExcerpt?: string
  readonly error?: string
  readonly retryOf?: RunId
  readonly concurrency?: ConcurrencySpec
}

/** Lease-fenced execution capability returned by an atomic claim. */
export interface RunClaim {
  readonly run: RunView
  readonly attempt: number
  readonly workerId: string
  readonly leaseToken: LeaseToken
  readonly leaseExpiresAt: number
  readonly sessionId: string
}

/** Terminal update committed by the Worker that still owns a lease. */
export interface RunSettlement {
  readonly state: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate'
  readonly outcome: RunOutcome
  readonly resultExcerpt?: string
  readonly error?: string
}

/** Validate runtime settlement payloads before they cross the durable boundary. */
export function resolveSettlement(settlement: RunSettlement): RunSettlement {
  const allowed: Readonly<Record<RunSettlement['state'], readonly RunOutcome[]>> = {
    succeeded: ['completed'],
    failed: ['blocked', 'max-tokens', 'error', 'not-dispatched'],
    cancelled: ['aborted', 'cancelled'],
    indeterminate: ['interrupted'],
  }
  if (!Object.hasOwn(allowed, settlement.state) || !allowed[settlement.state].includes(settlement.outcome)) {
    invalid(`outcome ${String(settlement.outcome)} is invalid for settlement state ${String(settlement.state)}`)
  }
  optionalBoundedText(settlement.resultExcerpt, 'result excerpt', 2_000)
  optionalBoundedText(settlement.error, 'settlement error', 4_000)
  return settlement
}

/** Stable coded failure from a domain or persistence precondition. */
export class AutomationError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'RUN_NOT_FOUND' | 'LEASE_LOST' | 'INVALID_TRANSITION' | 'STORE_INCOMPATIBLE' | 'EVENT_CURSOR_EXPIRED',
    message: string,
  ) {
    super(message)
    this.name = 'AutomationError'
  }
}

/** Validate and normalize one submission at the durable boundary. */
export function resolveSubmitRequest(request: SubmitRunRequest, now: number): Required<Pick<SubmitRunRequest, 'priority' | 'availableAt' | 'maxAttempts'>> & SubmitRunRequest {
  if (!Number.isSafeInteger(now) || now < 0) invalid('now must be a non-negative safe integer')
  const prompt = request.prompt.trim()
  if (prompt === '') invalid('prompt must not be empty')
  if (prompt.length > 1_000_000) invalid('prompt must not exceed 1000000 characters')
  if (request.target.kind !== 'fresh') invalid('target kind must be fresh')
  if (!isAbsolute(request.target.cwd)) invalid('fresh target cwd must be an absolute path')
  if (request.target.cwd.length > 4_096) invalid('fresh target cwd must not exceed 4096 characters')
  optionalBoundedText(request.target.preset, 'target preset', 256)
  optionalBoundedText(request.target.provider, 'target provider', 256)
  optionalBoundedText(request.target.model, 'target model', 512)
  if ((request.target.provider === undefined) !== (request.target.model === undefined)) {
    invalid('target provider and model must be supplied together')
  }
  optionalBoundedText(request.target.permissionPreset, 'target permission preset', 256)
  triggerKind(request.trigger.kind)
  boundedText(request.trigger.sourceId, 'trigger sourceId', 256)
  optionalBoundedText(request.trigger.occurrenceId, 'trigger occurrenceId', 512)
  optionalBoundedText(request.trigger.idempotencyKey, 'trigger idempotencyKey', 512)
  if (request.concurrency !== undefined) {
    boundedText(request.concurrency.key, 'concurrency key', 256)
    if (!Number.isSafeInteger(request.concurrency.limit) || request.concurrency.limit < 1 || request.concurrency.limit > 1_000) {
      invalid('concurrency limit must be an integer between 1 and 1000')
    }
  }
  const priority = request.priority ?? 0
  if (!Number.isSafeInteger(priority)) invalid('priority must be a safe integer')
  const availableAt = request.availableAt ?? now
  if (!Number.isSafeInteger(availableAt) || availableAt < 0) invalid('availableAt must be a non-negative safe integer')
  const maxAttempts = request.maxAttempts ?? 1
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) invalid('maxAttempts must be a positive safe integer')
  return { ...request, prompt, priority, availableAt, maxAttempts }
}

/** Parse and validate persisted Trigger JSON. */
export function decodeTrigger(value: unknown): TriggerSpec {
  const record = plainRecord(value, 'trigger')
  exactKeys(record, ['kind', 'sourceId'], ['occurrenceId', 'idempotencyKey'], 'trigger')
  if (typeof record['kind'] !== 'string' || typeof record['sourceId'] !== 'string') {
    invalid('persisted trigger is invalid')
  }
  triggerKind(record['kind'])
  boundedText(record['sourceId'], 'trigger sourceId', 256)
  const occurrenceId = optionalBoundedString(record['occurrenceId'], 'trigger occurrenceId', 512)
  const idempotencyKey = optionalBoundedString(record['idempotencyKey'], 'trigger idempotencyKey', 512)
  return {
    kind: record['kind'],
    sourceId: record['sourceId'],
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }
}

/** Parse and validate persisted concurrency JSON-compatible columns. */
export function decodeConcurrency(key: unknown, limit: unknown): ConcurrencySpec | undefined {
  if (key === null && limit === null) return undefined
  if (typeof key !== 'string' || typeof limit !== 'number') invalid('persisted concurrency is invalid')
  boundedText(key, 'concurrency key', 256)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid('persisted concurrency limit is invalid')
  return { key, limit }
}

/** Parse and validate persisted Target JSON. */
export function decodeTarget(value: unknown): TargetSpec {
  const record = plainRecord(value, 'target')
  exactKeys(record, ['kind', 'cwd'], ['preset', 'provider', 'model', 'permissionPreset'], 'target')
  if (record['kind'] !== 'fresh' || typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd'])) {
    invalid('persisted target is invalid')
  }
  if (record['cwd'].length > 4_096) invalid('persisted target cwd is too long')
  const preset = optionalBoundedString(record['preset'], 'target preset', 256)
  const provider = optionalBoundedString(record['provider'], 'target provider', 256)
  const model = optionalBoundedString(record['model'], 'target model', 512)
  const permissionPreset = optionalBoundedString(record['permissionPreset'], 'target permission preset', 256)
  return {
    kind: 'fresh',
    cwd: record['cwd'],
    ...(preset === undefined ? {} : { preset }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
  }
}

function optionalBoundedText(value: string | undefined, name: string, maxLength: number): void {
  if (value !== undefined) boundedText(value, name, maxLength)
}

function triggerKind(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid('trigger kind must be a lowercase adapter identifier')
}

function boundedText(value: string, name: string, maxLength: number): void {
  if (value.trim() === '' || value.length > maxLength) invalid(`${name} must be between 1 and ${maxLength} characters`)
}

function optionalBoundedString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${name} must be a string`)
  boundedText(value, name, maxLength)
  return value
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${name} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !allowed.has(key))) {
    invalid(`${name} contains missing or unknown fields`)
  }
}

function invalid(message: string): never {
  throw new AutomationError('INVALID_REQUEST', message)
}
