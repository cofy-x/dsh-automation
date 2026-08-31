import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationError, type LeaseToken, type RunId, type SubmitRunRequest } from '../src/domain.ts'
import { AutomationStore } from '../src/store.ts'
import { createSchemaV1 } from './fixtures/schema-v1.ts'

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

  it('accepts extensible Trigger namespaces and deduplicates one adapter occurrence', async () => {
    const store = await openStore()
    const trigger = {
      kind: 'cron', sourceId: 'cron-7', occurrenceId: '2026-09-01T01:00:00.000Z',
      idempotencyKey: 'v1:cron-7:2026-09-01T01:00:00.000Z',
    }
    const first = store.submit(request({ trigger }), 100)
    const duplicate = store.submit(request({ prompt: 'must not replace immutable work', trigger }), 101)

    expect(first.created).toBe(true)
    expect(duplicate).toEqual({ run: first.run, created: false })
    expect(first.run.trigger).toEqual(trigger)
    expect(() => store.submit(request({ trigger: { kind: 'Cron', sourceId: 'bad' } }), 102))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
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
    expect(() => store.submit(request({ trigger: { kind: 'webhook', sourceId: 'x'.repeat(257) } }), 100))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => store.get('run-missing' as RunId))
      .toThrow(new AutomationError('RUN_NOT_FOUND', 'run run-missing does not exist'))
    const run = store.submit(request(), 101).run
    const claim = store.claimNext('worker-a', 102, 100)!
    expect(() => store.settle(claim, { state: 'succeeded', outcome: 'error' }, 103))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(store.get(run.id).state).toBe('claimed')
  })

  it('coordinates claims across two SQLite connections', async () => {
    const first = await openStore()
    const second = await AutomationStore.open({ path: join(root!, 'automation.db') })
    stores.push(second)
    first.submit(request(), 100)

    expect(first.claimNext('worker-a', 101, 100)).toBeDefined()
    expect(second.claimNext('worker-b', 101, 100)).toBeUndefined()
  })

  it('enforces concurrency keys inside the cross-process claim transaction', async () => {
    const first = await openStore()
    const second = await AutomationStore.open({ path: join(root!, 'automation.db') })
    stores.push(second)
    const concurrency = { key: 'repository:cofy-x/dsh-automation', limit: 1 }
    first.submit(request({ prompt: 'first', concurrency }), 100)
    first.submit(request({ prompt: 'second', concurrency }), 101)

    const active = first.claimNext('worker-a', 110, 100)!
    expect(second.claimNext('worker-b', 110, 100)).toBeUndefined()
    first.settle(active, { state: 'succeeded', outcome: 'completed' }, 111)
    expect(second.claimNext('worker-b', 112, 100)?.run.prompt).toBe('second')
  })

  it('pauses new claims durably while allowing an owned Attempt to settle', async () => {
    const store = await openStore()
    store.submit(request({ prompt: 'active' }), 100)
    store.submit(request({ prompt: 'waiting' }), 101)
    const active = store.claimNext('worker-a', 102, 100)!

    expect(store.pause('planned maintenance', 103)).toEqual({
      mode: 'paused', paused: true, pausedAt: 103, reason: 'planned maintenance', updatedAt: 103,
    })
    expect(store.claimNext('worker-b', 104, 100)).toBeUndefined()
    expect(store.settle(active, { state: 'succeeded', outcome: 'completed' }, 105).state).toBe('succeeded')
    expect(store.resume(106)).toEqual({ mode: 'running', paused: false, updatedAt: 106 })
    expect(store.claimNext('worker-b', 107, 100)?.run.prompt).toBe('waiting')
  })

  it('requires explicit acknowledgement to retry indeterminate work and deduplicates the replacement', async () => {
    const store = await openStore()
    const original = store.submit(request({ concurrency: { key: 'repo:test', limit: 1 } }), 100).run
    const claim = store.claimNext('worker-a', 101, 100)!
    store.markRunning(claim, 102)
    store.settle(claim, { state: 'indeterminate', outcome: 'interrupted', error: 'unknown side effects' }, 103)

    expect(() => store.retry(original.id, { idempotencyKey: 'operator-1' }, 104))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    const first = store.retry(original.id, { idempotencyKey: 'operator-1', confirmIndeterminate: true }, 105)
    const duplicate = store.retry(original.id, { idempotencyKey: 'operator-1', confirmIndeterminate: true }, 106)
    expect(first.created).toBe(true)
    expect(first.run).toMatchObject({ retryOf: original.id, state: 'queued', concurrency: { key: 'repo:test', limit: 1 } })
    expect(duplicate).toEqual({ run: first.run, created: false })
  })

  it('migrates an existing schema v1 store transactionally to v2', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-automation-v1-'))
    const path = join(root, 'automation.db')
    createSchemaV1(path)

    const store = await AutomationStore.open({ path })
    stores.push(store)
    expect(store.status(20).schemaVersion).toBe(2)
    expect(store.get('run-v1' as RunId)).toMatchObject({
      prompt: 'migrate me',
      trigger: { kind: 'manual', sourceId: 'legacy', occurrenceId: 'old-1' },
    })
    expect(store.submit(request({
      trigger: { kind: 'webhook', sourceId: 'github', occurrenceId: 'delivery-1', idempotencyKey: 'github:delivery-1' },
      concurrency: { key: 'hook:github', limit: 2 },
    }), 21).run).toMatchObject({ concurrency: { key: 'hook:github', limit: 2 } })

    const freshPath = join(root, 'fresh.db')
    const fresh = await AutomationStore.open({ path: freshPath })
    stores.push(fresh)
    expect(schemaShape(path)).toEqual(schemaShape(freshPath))
  })

  it('paginates Runs and exposes a replayable trigger-filtered global event cursor', async () => {
    const store = await openStore()
    const cronOne = store.submit(request({
      prompt: 'cron one', trigger: { kind: 'cron', sourceId: 'job-1', occurrenceId: 'one' },
    }), 100).run
    store.submit(request({ prompt: 'manual' }), 101)
    const cronTwo = store.submit(request({
      prompt: 'cron two', trigger: { kind: 'cron', sourceId: 'job-1', occurrenceId: 'two' },
    }), 102).run

    const firstRuns = store.query({ triggerKind: 'cron', triggerSourceId: 'job-1', limit: 1 })
    expect(firstRuns).toMatchObject({ runs: [{ id: cronTwo.id }], hasMore: true })
    const secondRuns = store.query({
      triggerKind: 'cron', triggerSourceId: 'job-1', before: firstRuns.nextCursor!, limit: 1,
    })
    expect(secondRuns).toEqual({ runs: [cronOne], hasMore: false })

    const firstEvents = store.changes({ triggerKind: 'cron', triggerSourceId: 'job-1', limit: 1 })
    expect(firstEvents).toMatchObject({ events: [{ runId: cronOne.id, type: 'submitted' }], hasMore: true })
    const replayed = store.changes({
      afterSeq: firstEvents.nextSeq, triggerKind: 'cron', triggerSourceId: 'job-1', limit: 10,
    })
    expect(replayed).toMatchObject({ events: [{ runId: cronTwo.id, type: 'submitted' }], hasMore: false })
    expect(new Set([...firstEvents.events, ...replayed.events].map(event => event.seq)).size).toBe(2)
  })

  it('advances a filtered event consumer across windows containing only other Trigger kinds', async () => {
    const store = await openStore()
    store.submit(request({ trigger: { kind: 'manual', sourceId: 'cli' } }), 100)
    const cron = store.submit(request({ trigger: { kind: 'cron', sourceId: 'job-1' } }), 101).run

    const skipped = store.changes({ afterSeq: 0, triggerKind: 'cron', limit: 1 })
    expect(skipped).toMatchObject({ events: [], nextSeq: 1, hasMore: true })
    expect(store.changes({ afterSeq: skipped.nextSeq, triggerKind: 'cron', limit: 1 })).toMatchObject({
      events: [{ runId: cron.id }], nextSeq: 2, hasMore: false,
    })
  })

  it('protects retention with durable consumer checkpoints and expires pruned cursors', async () => {
    const store = await openStore()
    const first = store.submit(request({ prompt: 'first' }), 100).run
    const firstClaim = store.claimNext('worker-a', 101, 100)!
    store.settle(firstClaim, { state: 'succeeded', outcome: 'completed' }, 102)
    const firstLastSeq = store.events(first.id).at(-1)!.seq
    const second = store.submit(request({ prompt: 'second' }), 110).run
    const secondClaim = store.claimNext('worker-a', 111, 100)!
    store.settle(secondClaim, { state: 'failed', outcome: 'error', error: 'expected' }, 112)
    const secondLastSeq = store.events(second.id).at(-1)!.seq

    expect(store.checkpointConsumer('cron.reconciler', firstLastSeq, 120)).toEqual({
      id: 'cron.reconciler', lastSeq: firstLastSeq, updatedAt: 120,
    })
    expect(store.purge(200, 100)).toEqual({
      purgedRunIds: [first.id], protectedByEventSeq: firstLastSeq,
    })
    expect(() => store.changes({ afterSeq: 0 })).toThrow(expect.objectContaining({ code: 'EVENT_CURSOR_EXPIRED' }))
    expect(store.changes({ afterSeq: firstLastSeq })).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ runId: second.id })]),
      prunedThroughSeq: firstLastSeq,
    })

    expect(store.checkpointConsumer('cron.reconciler', secondLastSeq, 121).lastSeq).toBe(secondLastSeq)
    expect(() => store.checkpointConsumer('cron.reconciler', firstLastSeq, 122))
      .toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    expect(() => store.checkpointConsumer('webhook.reconciler', secondLastSeq + 1, 122))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(store.purge(200, 100).purgedRunIds).toEqual([second.id])
    expect(store.changes({ afterSeq: secondLastSeq })).toMatchObject({
      events: [], oldestAvailableSeq: 0, prunedThroughSeq: secondLastSeq,
    })
    expect(store.consumers()).toEqual([{ id: 'cron.reconciler', lastSeq: secondLastSeq, updatedAt: 121 }])
    expect(store.removeConsumer('cron.reconciler')).toBe(true)
    expect(store.removeConsumer('cron.reconciler')).toBe(false)
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
      health: 'degraded',
      schemaVersion: 2,
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
      workers: [
        { workerId: 'worker-a', activeAttempts: 1, oldestLeaseExpiresAt: 120 },
        { workerId: 'worker-b', activeAttempts: 1, oldestLeaseExpiresAt: 122 },
      ],
      eventFeed: { newestSeq: 6, prunedThroughSeq: 0, consumers: 0 },
      control: { mode: 'running', paused: false, updatedAt: 0 },
    })
    expect(() => store.status(-1)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(undispatched.run.prompt).toBe('queued-a')
  })
})

function schemaShape(path: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as { name: string }[]
    const indexes = database.prepare(`
      SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name
    `).all()
    return {
      tables: tables.map(({ name }) => ({
        name,
        columns: database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all(),
        foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all(),
      })),
      indexes,
    }
  } finally {
    database.close()
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
