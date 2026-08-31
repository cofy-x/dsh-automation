/** Automation profile application: management commands or long-lived Worker. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { RunId, RunView } from './domain.ts'
import type { AutomationService } from './index.ts'
import type { AutomationStartup } from './startup.ts'
import { AutomationWorkerPool } from './worker/pool.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-automation-app'

/** The app waits for the parsed command and durable service. */
export const inject = ['automation', 'automationStartup']

/** Process-facing output streams; tests may substitute captures. */
export const internals: {
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
} = { stdout: process.stdout, stderr: process.stderr }

/** Execute the parsed automation application mode. */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dsh-automation: the dsh launcher must provide ctx.appExit')
  const startup = ctx.automationStartup
  if (startup.mode === 'worker') {
    const worker = new AutomationWorkerPool(ctx, ctx.automation, startup, {
      info: message => { ctx.logger.info(message) },
      warn: message => { ctx.logger.warn(message) },
    })
    if (startup.once) {
      void worker.runOnce()
        .then((result) => {
          const human = result.claimedRunIds.length === 0
            ? `idle\trecovered=${result.recovered}`
            : `${result.claimedRunIds.join(',')}\tprocessed\trecovered=${result.recovered}`
          write(startup.json, result, human)
          exit(0)
        })
        .catch((error: unknown) => {
          internals.stderr.write(`dsh-automation: ${error instanceof Error ? error.message : String(error)}\n`)
          exit(1)
        })
    } else {
      ctx.effect(() => worker.start(), 'dsh-automation: Worker')
    }
    return
  }
  void runManagement(ctx.automation, startup)
    .then(() => { exit(0) })
    .catch((error: unknown) => {
      internals.stderr.write(`dsh-automation: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    })
}

async function runManagement(automation: AutomationService, startup: Exclude<AutomationStartup, { mode: 'worker' }>): Promise<void> {
  switch (startup.mode) {
    case 'submit': {
      const submitted = automation.submit({
        prompt: startup.prompt,
        target: {
          kind: 'fresh',
          cwd: startup.cwd,
          ...(startup.preset === undefined ? {} : { preset: startup.preset }),
          ...(startup.provider === undefined ? {} : { provider: startup.provider, model: startup.model as string }),
          ...(startup.permissionPreset === undefined ? {} : { permissionPreset: startup.permissionPreset }),
        },
        trigger: {
          kind: 'manual',
          sourceId: 'cli',
          occurrenceId: randomUUID(),
          ...(startup.idempotencyKey === undefined ? {} : { idempotencyKey: startup.idempotencyKey }),
        },
        priority: startup.priority,
        maxAttempts: startup.maxAttempts,
        ...(startup.concurrencyKey === undefined ? {} : {
          concurrency: { key: startup.concurrencyKey, limit: startup.concurrencyLimit as number },
        }),
      })
      write(startup.json, { ...submitted.run, created: submitted.created }, `${submitted.run.id} ${submitted.created ? 'queued' : 'existing'}`)
      return
    }
    case 'list': {
      const page = automation.query({
        ...(startup.state === undefined ? {} : { states: [startup.state] }),
        ...(startup.triggerKind === undefined ? {} : { triggerKind: startup.triggerKind }),
        ...(startup.triggerSourceId === undefined ? {} : { triggerSourceId: startup.triggerSourceId }),
        ...(startup.beforeCreatedAt === undefined ? {} : {
          before: { createdAt: startup.beforeCreatedAt, id: startup.beforeId as RunId },
        }),
        limit: startup.limit,
      })
      const cursor = page.nextCursor === undefined ? '' : `\nnext: ${page.nextCursor.createdAt} ${page.nextCursor.id}`
      write(startup.json, page, page.runs.map(runLine).join('\n') + cursor)
      return
    }
    case 'events': {
      const page = automation.changes({
        afterSeq: startup.afterSeq, limit: startup.limit,
        ...(startup.runId === undefined ? {} : { runId: startup.runId as RunId }),
        ...(startup.triggerKind === undefined ? {} : { triggerKind: startup.triggerKind }),
        ...(startup.triggerSourceId === undefined ? {} : { triggerSourceId: startup.triggerSourceId }),
      })
      const lines = page.events.map(event => `${event.seq}\t${event.runId}\t${event.type}\t${event.at}`).join('\n')
      write(startup.json, page, `${lines}${lines === '' ? '' : '\n'}next: ${page.nextSeq}`)
      return
    }
    case 'consumer-list': {
      const consumers = automation.consumers()
      write(startup.json, consumers, consumers.map(item => `${item.id}\t${item.lastSeq}\t${item.updatedAt}`).join('\n'))
      return
    }
    case 'consumer-checkpoint': {
      const consumer = automation.checkpointConsumer(startup.consumerId, startup.seq)
      write(startup.json, consumer, `${consumer.id}\t${consumer.lastSeq}\t${consumer.updatedAt}`)
      return
    }
    case 'consumer-remove': {
      const removed = automation.removeConsumer(startup.consumerId)
      write(startup.json, { consumerId: startup.consumerId, removed }, `${startup.consumerId}\t${removed ? 'removed' : 'not-found'}`)
      return
    }
    case 'purge': {
      const result = automation.purge(startup.before, startup.limit)
      write(startup.json, result, `purged=${result.purgedRunIds.length}\tprotected-by=${result.protectedByEventSeq ?? '-'}`)
      return
    }
    case 'status': {
      const status = automation.status()
      const oldest = status.queued.oldestCreatedAt === undefined
        ? '-'
        : `${Math.max(0, status.checkedAt - status.queued.oldestCreatedAt)}ms`
      write(
        startup.json,
        status,
        `ok\tschema=${status.schemaVersion}\tqueued=${status.queued.count}\tactive=${status.active}\texpired=${status.expired.undispatched + status.expired.dispatched}\tpaused=${status.control.paused}\toldest=${oldest}`,
      )
      return
    }
    case 'pause': {
      const control = automation.pause(startup.reason)
      write(startup.json, control, `paused\tat=${control.pausedAt ?? '-'}\treason=${control.reason ?? '-'}`)
      return
    }
    case 'resume': {
      const control = automation.resume()
      write(startup.json, control, 'running')
      return
    }
    case 'drain': {
      const control = automation.drain(startup.reason)
      const deadline = Date.now() + startup.timeoutMs
      let status = automation.status()
      while (status.active > 0 && Date.now() < deadline) {
        await delay(Math.min(startup.pollMs, Math.max(1, deadline - Date.now())))
        status = automation.status()
      }
      if (status.active > 0) throw new Error(`drain timed out with ${status.active} active Attempt(s)`)
      const value = { control, active: status.active, drainedAt: status.checkedAt }
      write(startup.json, value, `drained\tactive=0\tat=${status.checkedAt}`)
      return
    }
    case 'show': {
      const id = startup.runId as RunId
      const run = automation.get(id)
      const value = { run, events: automation.events(id) }
      write(startup.json, value, `${runLine(run)}\nsession: ${run.finalSessionId ?? '-'}\noutcome: ${run.outcome ?? '-'}\n${run.error ?? run.resultExcerpt ?? ''}`.trimEnd())
      return
    }
    case 'cancel': {
      const run = automation.cancel(startup.runId as RunId)
      write(startup.json, run, runLine(run))
      return
    }
    case 'retry': {
      const submitted = automation.retry(startup.runId as RunId, {
        idempotencyKey: startup.idempotencyKey ?? randomUUID(),
        ...(startup.confirmIndeterminate ? { confirmIndeterminate: true } : {}),
        ...(startup.priority === undefined ? {} : { priority: startup.priority }),
        ...(startup.maxAttempts === undefined ? {} : { maxAttempts: startup.maxAttempts }),
      })
      write(startup.json, { ...submitted.run, created: submitted.created }, `${submitted.run.id} ${submitted.created ? 'queued' : 'existing'} retry-of=${startup.runId}`)
      return
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function write(json: boolean, value: unknown, human: string): void {
  internals.stdout.write((json ? JSON.stringify(value) : human) + '\n')
}

function runLine(run: RunView): string {
  return `${run.id}\t${run.state}\t${run.prompt}`
}
