/** Deterministic keyless adapter for the installed-profile vertical smoke test. */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class AutomationFakeAdapter extends LlmAdapter {
  async * stream(options) {
    options.signal?.throwIfAborted()
    const text = 'AUTOMATION_VERTICAL_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'dsh-automation-fake-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['automation-fake'], new AutomationFakeAdapter())
  ctx.provide('automationFakeLlm', true)
}
