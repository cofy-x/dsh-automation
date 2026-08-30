import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { safeToResumeBeforeTurn, settlementFromEvents } from '../src/worker.ts'

describe('canonical Run settlement', () => {
  it('uses the final canonical completed turn and bounded assistant excerpt', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'assistant/message', seq: 1, time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'message-1', role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            source: { kind: 'model', provider: 'fake', model: 'fake' },
          },
          chunkSeqs: [],
        },
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    expect(settlementFromEvents(events)).toEqual({ state: 'succeeded', outcome: 'completed', resultExcerpt: 'done' })
  })

  it('never treats cold crash repair as a retryable failure', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ] as SessionEvent[]
    expect(settlementFromEvents(events)).toEqual({
      state: 'indeterminate',
      outcome: 'interrupted',
      error: 'canonical turn was interrupted by process loss',
    })
  })

  it('resumes only a durably spliced inbox that never started a turn', () => {
    const inboxOnly = [{ type: 'agent/inbox/spliced', seq: 0, time: 1, data: {} }] as unknown as SessionEvent[]
    const started = [...inboxOnly, { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }] as unknown as SessionEvent[]

    expect(safeToResumeBeforeTurn(inboxOnly)).toBe(true)
    expect(safeToResumeBeforeTurn([])).toBe(false)
    expect(safeToResumeBeforeTurn(started)).toBe(false)
  })
})
