import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RunId } from '../src/domain.ts'
import { isRecoveryWakeMessage } from '../src/worker.ts'
import { createTestRuntime, LEASE_MS } from './runtime-harness.ts'

type CrashMode = 'claimed' | 'inbox' | 'turn' | 'completed'

const childScript = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const roots: string[] = []

async function crashAt(mode: CrashMode): Promise<{ root: string; runId: RunId }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-automation-${mode}-`))
  roots.push(root)
  const marker = join(root, 'failpoint')
  const child = execa(process.execPath, ['--import', tsxLoader, childScript, mode, root, marker], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) },
    stdin: 'ignore',
    reject: false,
  })
  try {
    const payload = await vi.waitFor(async () => JSON.parse(await readFile(marker, 'utf8')) as { mode: CrashMode; runId: RunId }, {
      interval: 10,
      timeout: 30_000,
    })
    expect(payload.mode).toBe(mode)
    child.kill('SIGKILL')
    const exit = await child
    expect({ code: exit.exitCode ?? null, signal: exit.signal ?? null }).toEqual({ code: null, signal: 'SIGKILL' })
    await new Promise(resolve => { setTimeout(resolve, LEASE_MS + 100) })
    return { root, runId: payload.runId }
  } catch (error) {
    child.kill('SIGKILL')
    const exit = await child
    throw new Error(`crash child ${mode} failed: ${exit.stderr}`, { cause: error })
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('AutomationWorker hard-crash recovery', () => {
  it('requeues a claim that crashed before durable dispatch and succeeds on Attempt 2', async () => {
    const crashed = await crashAt('claimed')
    const runtime = await createTestRuntime(crashed.root, 'recovery-claimed')
    try {
      await runtime.worker.runOnce()
      expect(runtime.store.get(crashed.runId)).toMatchObject({ state: 'succeeded', attemptCount: 2, outcome: 'completed' })
      expect(runtime.store.events(crashed.runId).map(event => event.type)).toContain('requeued')
    } finally {
      await runtime.dispose()
    }
  }, 40_000)

  it('resumes an inbox-only durable Session once despite a stale recovery wake', async () => {
    const crashed = await crashAt('inbox')
    const runtime = await createTestRuntime(crashed.root, 'recovery-inbox')
    try {
      await runtime.worker.runOnce()
      const run = runtime.store.get(crashed.runId)
      expect(run.error).toBeUndefined()
      expect(run).toMatchObject({ state: 'succeeded', attemptCount: 1, outcome: 'completed' })
      const session = await runtime.ctx.sessionPersistence.inspect(SessionId(run.finalSessionId as string))
      const delivered = session.events
        .filter(event => event.type === 'user/message')
        .map(event => event.type === 'user/message' ? event.data : undefined)
        .filter(message => message !== undefined)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.content).toEqual([{ type: 'text', text: 'resume this exact durable inbox message' }])
      expect(delivered.some(isRecoveryWakeMessage)).toBe(false)
      expect(runtime.store.events(crashed.runId).map(event => event.type)).toContain('recovered-claim')
    } finally {
      await runtime.dispose()
    }
  }, 40_000)

  it('settles a hard-crashed open canonical turn as indeterminate without retry', async () => {
    const crashed = await crashAt('turn')
    const runtime = await createTestRuntime(crashed.root, 'recovery-turn')
    try {
      await runtime.worker.runOnce()
      expect(runtime.store.get(crashed.runId)).toMatchObject({
        state: 'indeterminate', attemptCount: 1, outcome: 'interrupted',
      })
      expect(runtime.store.events(crashed.runId).map(event => event.type)).not.toContain('requeued')
    } finally {
      await runtime.dispose()
    }
  }, 40_000)

  it('backfills a completed canonical Session when the Worker died before Run settlement', async () => {
    const crashed = await crashAt('completed')
    const runtime = await createTestRuntime(crashed.root, 'recovery-completed')
    try {
      await runtime.worker.runOnce()
      expect(runtime.store.get(crashed.runId)).toMatchObject({
        state: 'succeeded', attemptCount: 1, outcome: 'completed', resultExcerpt: 'AUTOMATION_CRASH_RECOVERY_OK',
      })
      expect(runtime.store.events(crashed.runId).map(event => event.type)).toContain('recovered-settlement')
    } finally {
      await runtime.dispose()
    }
  }, 40_000)
})
