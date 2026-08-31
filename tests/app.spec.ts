import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunId } from '../src/domain.ts'
import type { AutomationService } from '../src/index.ts'
import { apply, internals } from '../src/app.ts'
import type { AutomationStartup } from '../src/startup.ts'
import { AutomationWorker } from '../src/worker.ts'

const originalStdout = internals.stdout
const originalStderr = internals.stderr

afterEach(() => {
  internals.stdout = originalStdout
  internals.stderr = originalStderr
  vi.restoreAllMocks()
})

function run(startup: AutomationStartup, automation: Partial<AutomationService> = {}) {
  const ctx = new Context()
  let stdout = ''
  let stderr = ''
  internals.stdout = { write: text => { stdout += text } }
  internals.stderr = { write: text => { stderr += text } }
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>(resolve => { resolveExit = resolve })
  ctx.provide('appExit', resolveExit)
  ctx.provide('automationStartup', startup)
  ctx.provide('automation', automation as AutomationService)
  apply(ctx)
  return { exited, output: () => ({ stdout, stderr }) }
}

describe('automation application exit contract', () => {
  it('prints a JSON Worker cycle and exits zero', async () => {
    const id = 'run-00000000-0000-0000-0000-000000000000' as RunId
    vi.spyOn(AutomationWorker.prototype, 'runOnce').mockResolvedValue({ recovered: 2, claimedRunId: id })
    const invocation = run({
      mode: 'worker', pollMs: 1000, leaseMs: 30_000, slots: 1, shutdownGraceMs: 30_000, once: true, json: true,
    })

    await expect(invocation.exited).resolves.toBe(0)
    expect(invocation.output()).toEqual({
      stdout: `${JSON.stringify({ recovered: 2, claimedRunIds: [id] })}\n`,
      stderr: '',
    })
  })

  it('prints a Worker cycle failure and exits one', async () => {
    vi.spyOn(AutomationWorker.prototype, 'runOnce').mockRejectedValue(new Error('store unavailable'))
    const invocation = run({
      mode: 'worker', pollMs: 1000, leaseMs: 30_000, slots: 1, shutdownGraceMs: 30_000, once: true, json: false,
    })

    await expect(invocation.exited).resolves.toBe(1)
    expect(invocation.output()).toEqual({ stdout: '', stderr: 'dsh-automation: store unavailable\n' })
  })

  it('prints bounded status and exits zero', async () => {
    const invocation = run(
      { mode: 'status', json: false },
      {
        status: () => ({
          health: 'ok', schemaVersion: 1, checkedAt: 200,
          runs: { queued: 1, claimed: 0, running: 0, cancelling: 0, succeeded: 0, failed: 0, cancelled: 0, indeterminate: 0 },
          queued: { count: 1, oldestCreatedAt: 150 }, active: 0,
          expired: { undispatched: 0, dispatched: 0 },
          workers: [], eventFeed: { newestSeq: 0, prunedThroughSeq: 0, consumers: 0 },
          control: { mode: 'running', paused: false, updatedAt: 0 },
        }),
      },
    )

    await expect(invocation.exited).resolves.toBe(0)
    expect(invocation.output()).toEqual({ stdout: 'ok\tschema=1\tqueued=1\tactive=0\texpired=0\tpaused=false\toldest=50ms\n', stderr: '' })
  })

  it('prints durable queue control changes', async () => {
    const pause = run(
      { mode: 'pause', reason: 'maintenance', json: true },
      { pause: () => ({ mode: 'paused', paused: true, pausedAt: 100, reason: 'maintenance', updatedAt: 100 }) },
    )
    await expect(pause.exited).resolves.toBe(0)
    expect(pause.output().stdout).toBe(`${JSON.stringify({ mode: 'paused', paused: true, pausedAt: 100, reason: 'maintenance', updatedAt: 100 })}\n`)

    const resume = run(
      { mode: 'resume', json: false },
      { resume: () => ({ mode: 'running', paused: false, updatedAt: 101 }) },
    )
    await expect(resume.exited).resolves.toBe(0)
    expect(resume.output().stdout).toBe('running\n')
  })

  it('enters durable drain mode and exits after active Attempts finish', async () => {
    const invocation = run(
      { mode: 'drain', reason: 'deploy', timeoutMs: 1000, pollMs: 10, json: true },
      {
        drain: () => ({ mode: 'draining', paused: true, pausedAt: 100, reason: 'deploy', updatedAt: 100 }),
        status: () => ({
          health: 'ok', schemaVersion: 2, checkedAt: 101,
          runs: { queued: 0, claimed: 0, running: 0, cancelling: 0, succeeded: 1, failed: 0, cancelled: 0, indeterminate: 0 },
          queued: { count: 0 }, active: 0, expired: { undispatched: 0, dispatched: 0 },
          workers: [], eventFeed: { newestSeq: 1, prunedThroughSeq: 0, consumers: 0 },
          control: { mode: 'draining', paused: true, pausedAt: 100, reason: 'deploy', updatedAt: 100 },
        }),
      },
    )
    await expect(invocation.exited).resolves.toBe(0)
    expect(JSON.parse(invocation.output().stdout)).toMatchObject({ active: 0, drainedAt: 101 })
  })

  it('prints an explicit retry result', async () => {
    const id = 'run-new' as RunId
    const retry = vi.fn(() => ({
      run: {
        id, state: 'queued' as const, prompt: 'retry me', target: { kind: 'fresh' as const, cwd: '/workspace' },
        trigger: { kind: 'retry', sourceId: 'run-old' }, priority: 0, maxAttempts: 1, attemptCount: 0,
        createdAt: 1, updatedAt: 1, availableAt: 1, retryOf: 'run-old' as RunId,
      },
      created: true,
    }))
    const invocation = run(
      { mode: 'retry', runId: 'run-old', idempotencyKey: 'operator-1', confirmIndeterminate: true, json: false },
      { retry },
    )

    await expect(invocation.exited).resolves.toBe(0)
    expect(retry).toHaveBeenCalledWith('run-old', { idempotencyKey: 'operator-1', confirmIndeterminate: true })
    expect(invocation.output().stdout).toBe('run-new queued retry-of=run-old\n')
  })

  it('executes bounded event and retention management commands', async () => {
    const changes = vi.fn(() => ({
      events: [{ seq: 43, runId: 'run-1' as RunId, at: 100, type: 'settled', data: {} }],
      oldestAvailableSeq: 1, prunedThroughSeq: 0, nextSeq: 43, hasMore: false,
    }))
    const events = run(
      { mode: 'events', afterSeq: 42, triggerKind: 'cron', limit: 10, json: true },
      { changes },
    )
    await expect(events.exited).resolves.toBe(0)
    expect(changes).toHaveBeenCalledWith({ afterSeq: 42, limit: 10, triggerKind: 'cron' })
    expect(JSON.parse(events.output().stdout)).toMatchObject({ nextSeq: 43 })

    const purge = vi.fn(() => ({ purgedRunIds: ['run-old' as RunId], protectedByEventSeq: 50 }))
    const retention = run({ mode: 'purge', before: 1000, limit: 25, json: false }, { purge })
    await expect(retention.exited).resolves.toBe(0)
    expect(purge).toHaveBeenCalledWith(1000, 25)
    expect(retention.output().stdout).toBe('purged=1\tprotected-by=50\n')
  })
})
