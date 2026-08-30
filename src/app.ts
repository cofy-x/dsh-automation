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
import { AutomationWorker } from './worker.ts'

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
    const worker = new AutomationWorker(ctx, ctx.automation, startup, {
      info: message => { ctx.logger.info(message) },
      warn: message => { ctx.logger.warn(message) },
    })
    if (startup.once) {
      void worker.runOnce()
        .then((result) => {
          const human = result.claimedRunId === undefined
            ? `idle\trecovered=${result.recovered}`
            : `${result.claimedRunId}\tprocessed\trecovered=${result.recovered}`
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
      })
      write(startup.json, { ...submitted.run, created: submitted.created }, `${submitted.run.id} ${submitted.created ? 'queued' : 'existing'}`)
      return
    }
    case 'list': {
      const runs = automation.list(startup.state)
      write(startup.json, runs, runs.map(runLine).join('\n'))
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
        `ok\tschema=${status.schemaVersion}\tqueued=${status.queued.count}\tactive=${status.active}\texpired=${status.expired.undispatched + status.expired.dispatched}\toldest=${oldest}`,
      )
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
  }
}

function write(json: boolean, value: unknown, human: string): void {
  internals.stdout.write((json ? JSON.stringify(value) : human) + '\n')
}

function runLine(run: RunView): string {
  return `${run.id}\t${run.state}\t${run.prompt}`
}
