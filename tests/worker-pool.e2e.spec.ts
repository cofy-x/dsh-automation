import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationService } from '../src/index.ts'
import { AutomationWorkerPool } from '../src/worker/pool.ts'
import { createTestRuntime, LEASE_MS, TEST_PROVIDER } from './runtime-harness.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('AutomationWorkerPool', () => {
  it('executes two canonical fresh Sessions concurrently through independent slots', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-automation-pool-'))
    let arrivals = 0
    let release!: () => void
    const bothStreaming = new Promise<void>(resolve => { release = resolve })
    const runtime = await createTestRuntime(root, 'unused-harness-worker', {}, async () => {
      arrivals += 1
      if (arrivals === 2) release()
      await bothStreaming
    })
    try {
      for (const occurrenceId of ['one', 'two']) {
        runtime.store.submit({
          prompt: `parallel ${occurrenceId}`,
          target: { kind: 'fresh', cwd: root, provider: TEST_PROVIDER, model: 'deterministic' },
          trigger: { kind: 'manual', sourceId: 'pool-e2e', occurrenceId, idempotencyKey: occurrenceId },
        })
      }
      const pool = new AutomationWorkerPool(
        runtime.ctx,
        runtime.store as unknown as AutomationService,
        { workerId: 'pool-e2e', slots: 2, pollMs: 25, leaseMs: LEASE_MS },
        { info: () => {}, warn: () => {} },
      )
      const result = await pool.runOnce()

      expect(arrivals).toBe(2)
      expect(result.claimedRunIds).toHaveLength(2)
      expect(runtime.store.list().map(run => run.state)).toEqual(['succeeded', 'succeeded'])
      expect(runtime.store.list().map(run => run.finalSessionId).every(Boolean)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  }, 20_000)
})
