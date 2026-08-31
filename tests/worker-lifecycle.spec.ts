import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationService } from '../src/index.ts'
import { AutomationWorker } from '../src/worker.ts'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('AutomationWorker lifecycle', () => {
  it('stops claiming and lets an active pump finish within the shutdown grace', async () => {
    const active = deferred()
    const worker = new AutomationWorker(
      new Context(), {} as AutomationService,
      { workerId: 'test', pollMs: 1000, leaseMs: 10_000, shutdownGraceMs: 1000 },
      { info: vi.fn(), warn: vi.fn() },
    )
    const internals = worker as unknown as { pump(): Promise<unknown> }
    vi.spyOn(internals, 'pump').mockReturnValue(active.promise)
    const dispose = worker.start()
    const stopped = dispose()
    let finished = false
    void stopped.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    active.resolve()
    await stopped
    expect(finished).toBe(true)
  })

  it('cancels only after the configured shutdown grace expires', async () => {
    const active = deferred()
    const cancel = vi.fn(() => { active.resolve() })
    const warn = vi.fn()
    const worker = new AutomationWorker(
      new Context(), {} as AutomationService,
      { workerId: 'test', pollMs: 1000, leaseMs: 10_000, shutdownGraceMs: 1 },
      { info: vi.fn(), warn },
    )
    const internals = worker as unknown as { pump(): Promise<unknown>; activeAgent?: { cancel(reason: { kind: 'disposed' }): void } }
    vi.spyOn(internals, 'pump').mockReturnValue(active.promise)
    const dispose = worker.start()
    internals.activeAgent = { cancel }
    await dispose()
    expect(cancel).toHaveBeenCalledWith({ kind: 'disposed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded shutdown grace'))
  })
})
