/** Canonical Session evidence and inbox-only recovery controls. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RunSettlement } from '../domain.ts'

const RECOVERY_WAKE_SECTION = 'automation-recovery-wake'
const RECOVERY_WAKE_TEXT = 'Wake the recovered durable inbox; omit this control message from the model request.'

/** Create an identified steering item that wakes only through published Agent APIs. */
export function recoveryWakeMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: RECOVERY_WAKE_TEXT }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-automation',
      form: 'snapshot',
      sections: [{ name: RECOVERY_WAKE_SECTION, text: RECOVERY_WAKE_TEXT }],
    },
  })
}

/** Recognize only this plugin's exact non-model-facing recovery control item. */
export function isRecoveryWakeMessage(message: UserMessage): boolean {
  const source = message.source
  return source.kind === 'plugin'
    && source.plugin === 'dsh-automation'
    && source.form === 'snapshot'
    && source.sections.length === 1
    && source.sections[0]?.name === RECOVERY_WAKE_SECTION
    && source.sections[0].text === RECOVERY_WAKE_TEXT
}

/** Strip claimed recovery steering after it wakes the loop but before request material is committed. */
export function installRecoveryWakeFilter(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    const wakeIds = new Set(messages.filter(isRecoveryWakeMessage).map(message => message.id))
    const decision = await next()
    if (decision.kind === 'reject' || wakeIds.size === 0) return decision
    return {
      ...decision,
      messages: decision.messages.filter(message => !wakeIds.has(message.id)),
    }
  })
}

/** Derive the terminal Run projection from canonical Session events. */
export function settlementFromEvents(events: readonly SessionEvent[]): RunSettlement | undefined {
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  let excerpt = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text !== '') excerpt = text.slice(0, 500)
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  if (reason === undefined) return undefined
  const resultExcerpt = excerpt === '' ? {} : { resultExcerpt: excerpt }
  switch (reason.kind) {
    case 'completed':
      return { state: 'succeeded', outcome: 'completed', ...resultExcerpt }
    case 'blocked':
      return { state: 'failed', outcome: 'blocked', ...resultExcerpt }
    case 'max-tokens':
      return { state: 'failed', outcome: 'max-tokens', ...resultExcerpt }
    case 'error':
      return { state: 'failed', outcome: 'error', error: `${reason.error.code}: ${reason.error.message}`, ...resultExcerpt }
    case 'aborted':
      return { state: 'cancelled', outcome: 'aborted', ...resultExcerpt }
    case 'interrupted':
      return { state: 'indeterminate', outcome: 'interrupted', error: 'canonical turn was interrupted by process loss', ...resultExcerpt }
    default:
      return indeterminate(`unknown canonical turn outcome: ${JSON.stringify(reason)}`)
  }
}

/** A durable inbox splice without a started turn can be resumed without redelivery. */
export function safeToResumeBeforeTurn(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'agent/inbox/spliced')
    && events.every(event => event.type !== 'turn/start' && event.type !== 'turn/end')
}

/** Build the conservative terminal state for unknowable side effects. */
export function indeterminate(error: string): RunSettlement {
  return { state: 'indeterminate', outcome: 'interrupted', error }
}
