import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import type { AutomationService } from '../src/index.ts'
import { AutomationStore } from '../src/store.ts'
import { AutomationWorker, type WorkerHooks } from '../src/worker.ts'

export const TEST_PROVIDER = 'automation-crash-fixture'
// Keep the lease short enough for process-crash tests while leaving enough
// headroom for cold SQLite/Agent startup on contended CI runners. The previous
// 200 ms lease could expire during synchronous startup before its heartbeat
// interval received an event-loop turn, producing an environmental false loss.
export const LEASE_MS = 1_000

export interface TestRuntime {
  readonly ctx: Context
  readonly store: AutomationStore
  readonly worker: AutomationWorker
  dispose(): Promise<void>
}

class FixtureAdapter extends LlmAdapter {
  constructor(private readonly beforeResponse?: () => Promise<void>) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    await this.beforeResponse?.()
    const text = 'AUTOMATION_CRASH_RECOVERY_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount the same public Agent/Session seams used by the production Worker. */
export async function createTestRuntime(
  root: string,
  workerId: string,
  hooks: WorkerHooks = {},
  beforeResponse?: () => Promise<void>,
): Promise<TestRuntime> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  ctx.llm.registerAdapter([TEST_PROVIDER], new FixtureAdapter(beforeResponse))
  const store = await AutomationStore.open({ path: join(root, 'automation.db') })
  const worker = new AutomationWorker(
    ctx,
    store as unknown as AutomationService,
    { pollMs: 25, leaseMs: LEASE_MS, workerId },
    { info: () => {}, warn: () => {} },
    hooks,
  )
  return {
    ctx,
    store,
    worker,
    async dispose() {
      await ctx.fiber.dispose()
      store.close()
    },
  }
}
