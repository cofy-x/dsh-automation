/** Application-owned command line for the automation profile. */

import { Command, Option } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { RunState } from './domain.ts'

/** Service published after one valid automation command is parsed. */
export const AUTOMATION_STARTUP_SERVICE = 'automationStartup'

/** Parsed automation application invocation. */
export type AutomationStartup =
  | { readonly mode: 'worker'; readonly pollMs: number; readonly leaseMs: number; readonly workerId?: string }
  | {
      readonly mode: 'submit'
      readonly prompt: string
      readonly cwd: string
      readonly preset?: string
      readonly provider?: string
      readonly model?: string
      readonly permissionPreset?: string
      readonly idempotencyKey?: string
      readonly priority: number
      readonly maxAttempts: number
      readonly json: boolean
    }
  | { readonly mode: 'list'; readonly state?: RunState; readonly json: boolean }
  | { readonly mode: 'show'; readonly runId: string; readonly json: boolean }
  | { readonly mode: 'cancel'; readonly runId: string; readonly json: boolean }

declare module '@deepseek-ai/cordis' {
  interface Context {
    automationStartup: AutomationStartup
  }
}

/** Stable Cordis plugin name. */
export const name = 'dsh-automation-startup'

/** The startup parser requires the launcher's immutable inner argv. */
export const inject = ['cmdlineArgs']

/** Parse and publish exactly one automation subcommand. */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile automation')
    .description('Submit, inspect, cancel, and execute durable DSH automation Runs.')
    .showHelpAfterError()

  program.command('worker')
    .description('Run the durable local Worker until the process is stopped')
    .option('--poll-ms <milliseconds>', 'queue poll interval', positiveInteger, 1_000)
    .option('--lease-ms <milliseconds>', 'Attempt lease duration', positiveInteger, 30_000)
    .option('--worker-id <id>', 'stable diagnostic Worker id')
    .action((options: { pollMs: number; leaseMs: number; workerId?: string }) => {
      if (options.pollMs * 3 >= options.leaseMs) {
        program.error('error: --lease-ms must be greater than three polling intervals')
      }
      ctx.provide(AUTOMATION_STARTUP_SERVICE, {
        mode: 'worker', pollMs: options.pollMs, leaseMs: options.leaseMs,
        ...(options.workerId === undefined ? {} : { workerId: requiredText(options.workerId, '--worker-id') }),
      } satisfies AutomationStartup)
    })

  program.command('submit')
    .description('Persist one Run and exit')
    .argument('<prompt...>', 'task text')
    .option('--cwd <path>', 'fresh Session workspace', process.cwd())
    .option('--preset <name>', 'DSH Agent preset')
    .option('--provider <name>', 'model provider; requires --model')
    .option('--model <id>', 'model id; requires --provider')
    .option('--permission <preset>', 'permission preset')
    .option('--idempotency-key <key>', 'deduplicate within the manual CLI Trigger namespace')
    .option('--priority <integer>', 'higher Runs are claimed first', safeInteger, 0)
    .option('--max-attempts <integer>', 'maximum automatic Attempts', positiveInteger, 1)
    .option('--json', 'print machine-readable JSON', false)
    .action((parts: string[], options: {
      cwd: string
      preset?: string
      provider?: string
      model?: string
      permission?: string
      idempotencyKey?: string
      priority: number
      maxAttempts: number
      json: boolean
    }) => {
      if ((options.provider === undefined) !== (options.model === undefined)) {
        program.error('error: --provider and --model must be supplied together')
      }
      const prompt = parts.join(' ').trim()
      if (prompt === '') program.error('error: prompt must not be empty')
      ctx.provide(AUTOMATION_STARTUP_SERVICE, {
        mode: 'submit',
        prompt,
        cwd: options.cwd,
        priority: options.priority,
        maxAttempts: options.maxAttempts,
        json: options.json,
        ...(options.preset === undefined ? {} : { preset: requiredText(options.preset, '--preset') }),
        ...(options.provider === undefined ? {} : { provider: requiredText(options.provider, '--provider') }),
        ...(options.model === undefined ? {} : { model: requiredText(options.model, '--model') }),
        ...(options.permission === undefined ? {} : { permissionPreset: requiredText(options.permission, '--permission') }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: requiredText(options.idempotencyKey, '--idempotency-key') }),
      } satisfies AutomationStartup)
    })

  program.command('list')
    .description('List durable Runs')
    .addOption(new Option('--state <state>', 'filter by state').choices([
      'queued', 'claimed', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'indeterminate',
    ]))
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { state?: RunState; json: boolean }) => {
      ctx.provide(AUTOMATION_STARTUP_SERVICE, {
        mode: 'list', json: options.json, ...(options.state === undefined ? {} : { state: options.state }),
      } satisfies AutomationStartup)
    })

  for (const mode of ['show', 'cancel'] as const) {
    program.command(mode)
      .description(mode === 'show' ? 'Show one Run and its audit events' : 'Request Run cancellation')
      .argument('<run-id>')
      .option('--json', 'print machine-readable JSON', false)
      .action((runId: string, options: { json: boolean }) => {
        ctx.provide(AUTOMATION_STARTUP_SERVICE, { mode, runId: requiredText(runId, 'run-id'), json: options.json })
      })
  }

  parseCmdline(ctx, program)
}

function safeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('expected a safe integer')
  return parsed
}

function positiveInteger(value: string): number {
  const parsed = safeInteger(value)
  if (parsed < 1) throw new Error('expected a positive integer')
  return parsed
}

function requiredText(value: string, name: string): string {
  if (value.trim() === '') throw new Error(`${name} must not be empty`)
  return value
}
