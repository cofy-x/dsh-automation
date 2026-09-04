import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { RunClaim, RunId } from '../../src/domain.ts'
import { AutomationStore } from '../../src/store.ts'
import { recoveryWakeMessage } from '../../src/worker.ts'
import { createTestRuntime, LEASE_MS, TEST_PROVIDER } from '../runtime-harness.ts'

type CrashMode = 'claimed' | 'inbox' | 'turn' | 'completed'

const [mode, root, marker] = process.argv.slice(2) as [CrashMode | undefined, string | undefined, string | undefined]
if (mode === undefined || !['claimed', 'inbox', 'turn', 'completed'].includes(mode) || root === undefined || marker === undefined) {
  throw new Error('usage: crash-child.ts <claimed|inbox|turn|completed> <root> <marker>')
}
const crashMode = mode
const crashRoot = root
const crashMarker = marker

function request() {
  return {
    prompt: `exercise ${crashMode} crash recovery`,
    target: { kind: 'fresh' as const, cwd: crashRoot, provider: TEST_PROVIDER, model: 'deterministic' },
    trigger: { kind: 'manual' as const, sourceId: 'crash-e2e', idempotencyKey: crashMode },
    maxAttempts: 2,
  }
}

async function publish(runId: RunId): Promise<never> {
  await writeFile(crashMarker, JSON.stringify({ mode: crashMode, runId }))
  return await new Promise<never>(() => { setInterval(() => {}, 60_000) })
}

if (crashMode === 'inbox') {
  const store = await AutomationStore.open({ path: join(crashRoot, 'automation.db') })
  const run = store.submit(request()).run
  const claim = store.claimNext('crash-inbox', Date.now(), LEASE_MS) as RunClaim
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(crashRoot, 'sessions'), compression: 'none' })
  const session = ctx.sessions.create(SessionId(claim.sessionId), { meta: { cwd: crashRoot } })
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [
      createUserMessage({
        content: [{ type: 'text', text: 'resume this exact durable inbox message' }],
        source: { kind: 'plugin', plugin: 'dsh-automation' },
      }),
      // Simulate a previous recovery process dying after it durably steered the
      // public wake token but before Core opened a turn.
      recoveryWakeMessage(),
    ],
  })
  await ctx.sessions.flush(session)
  store.markRunning(claim, Date.now())
  await publish(run.id)
}

let runtime: Awaited<ReturnType<typeof createTestRuntime>>
const hook = async (point: 'after-claim' | 'after-dispatch' | 'before-settle', claim: RunClaim): Promise<void> => {
  if (crashMode === 'claimed' && point === 'after-claim') await publish(claim.run.id)
  if (crashMode === 'completed' && point === 'before-settle') await publish(claim.run.id)
}
const beforeResponse = crashMode === 'turn'
  ? async () => {
      const run = runtime.store.list()[0]
      if (run === undefined) throw new Error('crash fixture Run disappeared')
      await publish(run.id)
    }
  : undefined
runtime = await createTestRuntime(crashRoot, `crash-${crashMode}`, { checkpoint: hook }, beforeResponse)
runtime.store.submit(request())
await runtime.worker.runOnce()
throw new Error(`crash fixture ${crashMode} unexpectedly completed without reaching its failpoint`)
