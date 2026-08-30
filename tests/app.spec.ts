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
    const invocation = run({ mode: 'worker', pollMs: 1000, leaseMs: 30_000, once: true, json: true })

    await expect(invocation.exited).resolves.toBe(0)
    expect(invocation.output()).toEqual({
      stdout: `${JSON.stringify({ recovered: 2, claimedRunId: id })}\n`,
      stderr: '',
    })
  })

  it('prints a Worker cycle failure and exits one', async () => {
    vi.spyOn(AutomationWorker.prototype, 'runOnce').mockRejectedValue(new Error('store unavailable'))
    const invocation = run({ mode: 'worker', pollMs: 1000, leaseMs: 30_000, once: true, json: false })

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
        }),
      },
    )

    await expect(invocation.exited).resolves.toBe(0)
    expect(invocation.output()).toEqual({ stdout: 'ok\tschema=1\tqueued=1\tactive=0\texpired=0\toldest=50ms\n', stderr: '' })
  })
})
