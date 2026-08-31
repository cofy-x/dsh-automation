/** Application-owned command line for the automation profile. */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { RunState } from './domain.ts'
import { registerManagementCommands } from './startup/management.ts'

/** Service published after one valid automation command is parsed. */
export const AUTOMATION_STARTUP_SERVICE = 'automationStartup'

/** Parsed automation application invocation. */
export type AutomationStartup =
  | {
      readonly mode: 'worker'; readonly pollMs: number; readonly leaseMs: number; readonly workerId?: string
      readonly slots: number; readonly shutdownGraceMs: number; readonly once: boolean; readonly json: boolean
    }
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
      readonly concurrencyKey?: string
      readonly concurrencyLimit?: number
      readonly json: boolean
    }
  | {
      readonly mode: 'list'; readonly state?: RunState; readonly triggerKind?: string; readonly triggerSourceId?: string
      readonly limit: number; readonly beforeCreatedAt?: number; readonly beforeId?: string; readonly json: boolean
    }
  | {
      readonly mode: 'events'; readonly afterSeq: number; readonly runId?: string; readonly triggerKind?: string
      readonly triggerSourceId?: string; readonly limit: number; readonly json: boolean
    }
  | { readonly mode: 'consumer-list'; readonly json: boolean }
  | { readonly mode: 'consumer-checkpoint'; readonly consumerId: string; readonly seq: number; readonly json: boolean }
  | { readonly mode: 'consumer-remove'; readonly consumerId: string; readonly json: boolean }
  | { readonly mode: 'purge'; readonly before: number; readonly limit: number; readonly json: boolean }
  | { readonly mode: 'status'; readonly json: boolean }
  | { readonly mode: 'pause'; readonly reason?: string; readonly json: boolean }
  | { readonly mode: 'drain'; readonly reason?: string; readonly timeoutMs: number; readonly pollMs: number; readonly json: boolean }
  | { readonly mode: 'resume'; readonly json: boolean }
  | { readonly mode: 'show'; readonly runId: string; readonly json: boolean }
  | { readonly mode: 'cancel'; readonly runId: string; readonly json: boolean }
  | {
      readonly mode: 'retry'; readonly runId: string; readonly idempotencyKey?: string; readonly confirmIndeterminate: boolean
      readonly priority?: number; readonly maxAttempts?: number; readonly json: boolean
    }

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
    .option('--slots <count>', 'parallel lease-owning Worker slots (maximum 64)', workerSlots, 1)
    .option('--shutdown-grace-ms <milliseconds>', 'wait for active turns before cancellation', positiveInteger, 30_000)
    .option('--once', 'run one bounded recovery-and-claim cycle, then exit', false)
    .option('--json', 'print the --once result as machine-readable JSON', false)
    .action((options: {
      pollMs: number; leaseMs: number; workerId?: string; slots: number; shutdownGraceMs: number; once: boolean; json: boolean
    }) => {
      if (options.json && !options.once) {
        program.error('error: worker --json requires --once')
      }
      if (options.pollMs * 3 >= options.leaseMs) {
        program.error('error: --lease-ms must be greater than three polling intervals')
      }
      ctx.provide(AUTOMATION_STARTUP_SERVICE, {
        mode: 'worker', pollMs: options.pollMs, leaseMs: options.leaseMs, slots: options.slots,
        shutdownGraceMs: options.shutdownGraceMs, once: options.once, json: options.json,
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
    .option('--concurrency-key <key>', 'database-enforced admission group')
    .option('--concurrency-limit <integer>', 'maximum active Runs in the admission group', positiveInteger)
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
      concurrencyKey?: string
      concurrencyLimit?: number
      json: boolean
    }) => {
      if ((options.provider === undefined) !== (options.model === undefined)) {
        program.error('error: --provider and --model must be supplied together')
      }
      const prompt = parts.join(' ').trim()
      if (prompt === '') program.error('error: prompt must not be empty')
      if ((options.concurrencyKey === undefined) !== (options.concurrencyLimit === undefined)) {
        program.error('error: --concurrency-key and --concurrency-limit must be supplied together')
      }
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
        ...(options.concurrencyKey === undefined ? {} : {
          concurrencyKey: requiredText(options.concurrencyKey, '--concurrency-key'), concurrencyLimit: options.concurrencyLimit,
        }),
      } satisfies AutomationStartup)
    })

  registerManagementCommands(program, ctx)

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

function workerSlots(value: string): number {
  const parsed = positiveInteger(value)
  if (parsed > 64) throw new Error('expected an integer between 1 and 64')
  return parsed
}

function requiredText(value: string, name: string): string {
  if (value.trim() === '') throw new Error(`${name} must not be empty`)
  return value
}
