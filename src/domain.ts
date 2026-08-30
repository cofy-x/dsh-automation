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
  readonly kind: 'manual'
  readonly sourceId: string
  readonly occurrenceId?: string
  readonly idempotencyKey?: string
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

/** Stable coded failure from a domain or persistence precondition. */
export class AutomationError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'RUN_NOT_FOUND' | 'LEASE_LOST' | 'INVALID_TRANSITION' | 'STORE_INCOMPATIBLE',
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
  if (request.target.kind !== 'fresh') invalid('target kind must be fresh')
  if (!isAbsolute(request.target.cwd)) invalid('fresh target cwd must be an absolute path')
  nonEmpty(request.target.preset, 'target preset')
  nonEmpty(request.target.provider, 'target provider')
  nonEmpty(request.target.model, 'target model')
  if ((request.target.provider === undefined) !== (request.target.model === undefined)) {
    invalid('target provider and model must be supplied together')
  }
  nonEmpty(request.target.permissionPreset, 'target permission preset')
  if (request.trigger.kind !== 'manual') invalid('trigger kind must be manual')
  if (request.trigger.sourceId.trim() === '') invalid('trigger sourceId must not be empty')
  nonEmpty(request.trigger.occurrenceId, 'trigger occurrenceId')
  nonEmpty(request.trigger.idempotencyKey, 'trigger idempotencyKey')
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
  if (record['kind'] !== 'manual' || typeof record['sourceId'] !== 'string' || record['sourceId'].trim() === '') {
    invalid('persisted trigger is invalid')
  }
  const occurrenceId = optionalNonEmptyString(record['occurrenceId'], 'trigger occurrenceId')
  const idempotencyKey = optionalNonEmptyString(record['idempotencyKey'], 'trigger idempotencyKey')
  return {
    kind: 'manual',
    sourceId: record['sourceId'],
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }
}

/** Parse and validate persisted Target JSON. */
export function decodeTarget(value: unknown): TargetSpec {
  const record = plainRecord(value, 'target')
  exactKeys(record, ['kind', 'cwd'], ['preset', 'provider', 'model', 'permissionPreset'], 'target')
  if (record['kind'] !== 'fresh' || typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd'])) {
    invalid('persisted target is invalid')
  }
  const preset = optionalNonEmptyString(record['preset'], 'target preset')
  const provider = optionalNonEmptyString(record['provider'], 'target provider')
  const model = optionalNonEmptyString(record['model'], 'target model')
  const permissionPreset = optionalNonEmptyString(record['permissionPreset'], 'target permission preset')
  return {
    kind: 'fresh',
    cwd: record['cwd'],
    ...(preset === undefined ? {} : { preset }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
  }
}

function nonEmpty(value: string | undefined, name: string): void {
  if (value !== undefined && value.trim() === '') invalid(`${name} must not be empty`)
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a non-empty string`)
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
