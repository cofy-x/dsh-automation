import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { AutomationService } from '../src/index.ts'
import { AutomationStore } from '../src/store.ts'
import { AutomationWorker, type WorkerHooks } from '../src/worker.ts'

export const TEST_PROVIDER = 'automation-crash-fixture'
export const LEASE_MS = 200

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
  // AgentLoop 0.1.2-alpha.2 consumes the public projection registry for its
  // durable turn-boundary projection. Production compositions mount this
  // service independently; make the test host topology explicit as well.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.db') })
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
