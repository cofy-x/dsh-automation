import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationError, type LeaseToken, type RunId, type SubmitRunRequest } from '../src/domain.ts'
import { AutomationStore } from '../src/store.ts'

let root: string | undefined
let stores: AutomationStore[] = []

afterEach(async () => {
  for (const store of stores) store.close()
  stores = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function openStore(): Promise<AutomationStore> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-automation-'))
  const store = await AutomationStore.open({ path: join(root, 'automation.db') })
  stores.push(store)
  return store
}

function request(overrides: Partial<SubmitRunRequest> = {}): SubmitRunRequest {
  return {
    prompt: 'inspect the failing tests',
    target: { kind: 'fresh', cwd: '/workspace', permissionPreset: 'workspace-write' },
    trigger: { kind: 'manual', sourceId: 'cli' },
    ...overrides,
  }
}

describe('AutomationStore', () => {
  it('submits immutable Runs and deduplicates within a Trigger namespace', async () => {
    const store = await openStore()
    const first = store.submit(request({ trigger: { kind: 'manual', sourceId: 'cli', idempotencyKey: 'request-1' } }), 100)
    const duplicate = store.submit(request({
      prompt: 'a different duplicate payload',
      trigger: { kind: 'manual', sourceId: 'cli', idempotencyKey: 'request-1' },
    }), 101)
    const otherSource = store.submit(request({ trigger: { kind: 'manual', sourceId: 'api', idempotencyKey: 'request-1' } }), 102)

    expect(first.created).toBe(true)
    expect(duplicate).toEqual({ run: first.run, created: false })
    expect(otherSource.created).toBe(true)
    expect(store.list()).toHaveLength(2)
    expect(store.events(first.run.id).map(event => event.type)).toEqual(['submitted'])
  })

  it('claims by priority and fences every lease-owned transition', async () => {
    const store = await openStore()
    store.submit(request({ prompt: 'low', priority: 1 }), 100)
    const high = store.submit(request({ prompt: 'high', priority: 9 }), 101).run

    const claim = store.claimNext('worker-a', 200, 50)
    expect(claim?.run.id).toBe(high.id)
    expect(claim?.sessionId).toBe(`dsh-automation-${high.id}-a1`)
    const running = store.markRunning(claim!, 210)
    expect(running.state).toBe('running')
    const refreshed = store.heartbeat(claim!, 220, 50)
    expect(refreshed.leaseExpiresAt).toBe(270)
    const stale = { ...refreshed, leaseToken: 'stale-token' as LeaseToken }
    expect(() => store.settle(stale, { state: 'succeeded', outcome: 'completed' }, 260))
      .toThrow(expect.objectContaining({ code: 'LEASE_LOST' }))
    const settled = store.settle(refreshed, { state: 'succeeded', outcome: 'completed', resultExcerpt: 'done' }, 260)
    expect(settled).toMatchObject({ state: 'succeeded', outcome: 'completed', resultExcerpt: 'done' })
    expect(store.events(high.id).map(event => event.type)).toEqual(['submitted', 'claimed', 'running', 'settled'])
  })

  it('requeues only expired Attempts that never crossed durable dispatch', async () => {
    const store = await openStore()
    const run = store.submit(request({ maxAttempts: 2 }), 100).run
    const first = store.claimNext('worker-a', 110, 10)!

    expect(store.recoverUndispatchedExpired(121)).toEqual([run.id])
    expect(store.get(run.id)).toMatchObject({ state: 'queued', attemptCount: 1 })
    const second = store.claimNext('worker-b', 122, 10)!
    expect(second.attempt).toBe(2)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(store.recoverUndispatchedExpired(133)).toEqual([run.id])
    expect(store.get(run.id)).toMatchObject({ state: 'failed', outcome: 'not-dispatched' })
  })

  it('never automatically requeues an expired dispatched Attempt', async () => {
    const store = await openStore()
    const run = store.submit(request({ maxAttempts: 3 }), 100).run
    const claim = store.claimNext('worker-a', 110, 10)!
    store.markRunning(claim, 111)

    expect(store.recoverUndispatchedExpired(121)).toEqual([])
    const expired = { runId: run.id, attempt: 1, sessionId: claim.sessionId }
    expect(store.expiredDispatched(121)).toEqual([expired])
    const settled = store.settleExpiredIndeterminate(expired, 'canonical turn was interrupted', 121)
    expect(settled).toMatchObject({ state: 'indeterminate', outcome: 'interrupted', error: 'canonical turn was interrupted' })
    expect(store.claimNext('worker-b', 122, 10)).toBeUndefined()
  })

  it('fences takeover of an expired dispatched Attempt without minting a duplicate Attempt', async () => {
    const store = await openStore()
    const run = store.submit(request(), 100).run
    const first = store.claimNext('worker-a', 110, 10)!
    store.markRunning(first, 111)
    const ref = store.expiredDispatched(121)[0]!

    const recovered = store.reclaimDispatched(ref, 'worker-b', 121, 50)!
    expect(recovered).toMatchObject({ attempt: 1, workerId: 'worker-b', sessionId: first.sessionId })
    expect(recovered.leaseToken).not.toBe(first.leaseToken)
    expect(store.reclaimDispatched(ref, 'worker-c', 121, 50)).toBeUndefined()
    expect(() => store.settle(first, { state: 'succeeded', outcome: 'completed' }, 122))
      .toThrow(expect.objectContaining({ code: 'LEASE_LOST' }))
    expect(store.settle(recovered, { state: 'succeeded', outcome: 'completed' }, 122)).toMatchObject({
      id: run.id,
      state: 'succeeded',
      attemptCount: 1,
    })
  })

  it('cancels queued Runs atomically and marks live Runs cancelling', async () => {
    const store = await openStore()
    const queued = store.submit(request(), 100).run
    expect(store.requestCancel(queued.id, 101)).toMatchObject({ state: 'cancelled', outcome: 'cancelled' })

    const live = store.submit(request(), 102).run
    store.claimNext('worker-a', 103, 100)
    expect(store.requestCancel(live.id, 104)).toMatchObject({ state: 'cancelling', cancelRequestedAt: 104 })
  })

  it('preserves cancellation when durable dispatch races with a cancel request', async () => {
    const store = await openStore()
    const run = store.submit(request(), 100).run
    const claim = store.claimNext('worker-a', 101, 100)!

    store.requestCancel(run.id, 102)
    expect(store.markRunning(claim, 103)).toMatchObject({ state: 'cancelling', cancelRequestedAt: 102 })
    expect(store.expiredDispatched(202)).toEqual([{
      runId: run.id,
      attempt: 1,
      sessionId: claim.sessionId,
    }])
  })

  it('rejects unsafe durable input and unknown Runs', async () => {
    const store = await openStore()
    expect(() => store.submit(request({ target: { kind: 'fresh', cwd: 'relative' } }), 100))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => store.get('run-missing' as RunId))
      .toThrow(new AutomationError('RUN_NOT_FOUND', 'run run-missing does not exist'))
  })

  it('coordinates claims across two SQLite connections', async () => {
    const first = await openStore()
    const second = await AutomationStore.open({ path: join(root!, 'automation.db') })
    stores.push(second)
    first.submit(request(), 100)

    expect(first.claimNext('worker-a', 101, 100)).toBeDefined()
    expect(second.claimNext('worker-b', 101, 100)).toBeUndefined()
  })

  it('reports bounded store and queue health including expired lease classes', async () => {
    const store = await openStore()
    store.submit(request({ prompt: 'queued-a' }), 90)
    store.submit(request({ prompt: 'queued-b' }), 100)
    const undispatched = store.claimNext('worker-a', 110, 10)!
    const dispatchedRun = store.submit(request({ prompt: 'dispatched', priority: 9 }), 111).run
    const dispatched = store.claimNext('worker-b', 112, 10)!
    expect(dispatched.run.id).toBe(dispatchedRun.id)
    store.markRunning(dispatched, 113)

    expect(store.status(123)).toEqual({
      health: 'ok',
      schemaVersion: 1,
      checkedAt: 123,
      runs: {
        queued: 1,
        claimed: 1,
        running: 1,
        cancelling: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        indeterminate: 0,
      },
      queued: { count: 1, oldestCreatedAt: 100 },
      active: 2,
      expired: { undispatched: 1, dispatched: 1 },
    })
    expect(() => store.status(-1)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(undispatched.run.prompt).toBe('queued-a')
  })
})
