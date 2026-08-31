/** Bounded query, queue control, retry, and retention command registration. */

import type { Context } from '@deepseek-ai/cordis'
import { Option, type Command } from 'commander'
import type { RunState } from '../domain.ts'
import type { AutomationStartup } from '../startup.ts'

export function registerManagementCommands(program: Command, ctx: Context): void {
  program.command('list')
    .description('Query a bounded page of durable Runs')
    .addOption(new Option('--state <state>', 'filter by state').choices([
      'queued', 'claimed', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'indeterminate',
    ]))
    .option('--trigger-kind <kind>', 'filter by Trigger adapter kind')
    .option('--trigger-source <id>', 'filter by Trigger source id')
    .option('--limit <count>', 'page size (maximum 200)', positiveInteger, 50)
    .option('--before-created-at <epoch-ms>', 'next-page cursor creation time', nonNegativeInteger)
    .option('--before-id <run-id>', 'next-page cursor Run id')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: {
      state?: RunState; triggerKind?: string; triggerSource?: string; limit: number
      beforeCreatedAt?: number; beforeId?: string; json: boolean
    }) => {
      if ((options.beforeCreatedAt === undefined) !== (options.beforeId === undefined)) {
        program.error('error: --before-created-at and --before-id must be supplied together')
      }
      publish(ctx, {
        mode: 'list', limit: options.limit, json: options.json,
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.triggerKind === undefined ? {} : { triggerKind: requiredText(options.triggerKind, '--trigger-kind') }),
        ...(options.triggerSource === undefined ? {} : { triggerSourceId: requiredText(options.triggerSource, '--trigger-source') }),
        ...(options.beforeCreatedAt === undefined ? {} : {
          beforeCreatedAt: options.beforeCreatedAt, beforeId: requiredText(options.beforeId as string, '--before-id'),
        }),
      })
    })

  program.command('events')
    .description('Read the durable global Run event feed')
    .option('--after-seq <sequence>', 'exclusive global event cursor', nonNegativeInteger, 0)
    .option('--run-id <run-id>', 'filter by Run id')
    .option('--trigger-kind <kind>', 'filter by Trigger adapter kind')
    .option('--trigger-source <id>', 'filter by Trigger source id')
    .option('--limit <count>', 'page size (maximum 200)', positiveInteger, 50)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: {
      afterSeq: number; runId?: string; triggerKind?: string; triggerSource?: string; limit: number; json: boolean
    }) => {
      publish(ctx, {
        mode: 'events', afterSeq: options.afterSeq, limit: options.limit, json: options.json,
        ...(options.runId === undefined ? {} : { runId: requiredText(options.runId, '--run-id') }),
        ...(options.triggerKind === undefined ? {} : { triggerKind: requiredText(options.triggerKind, '--trigger-kind') }),
        ...(options.triggerSource === undefined ? {} : { triggerSourceId: requiredText(options.triggerSource, '--trigger-source') }),
      })
    })

  registerConsumerCommands(program, ctx)
  registerQueueCommands(program, ctx)
  registerRunCommands(program, ctx)
}

function registerConsumerCommands(program: Command, ctx: Context): void {
  program.command('consumers').description('List durable event-feed consumer checkpoints')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }) => { publish(ctx, { mode: 'consumer-list', json: options.json }) })

  program.command('consumer-checkpoint').description('Advance one event-feed consumer checkpoint')
    .argument('<consumer-id>').argument('<sequence>', 'processed global event sequence', nonNegativeInteger)
    .option('--json', 'print machine-readable JSON', false)
    .action((consumerId: string, seq: number, options: { json: boolean }) => {
      publish(ctx, { mode: 'consumer-checkpoint', consumerId: requiredText(consumerId, 'consumer-id'), seq, json: options.json })
    })

  program.command('consumer-remove').description('Unregister an event-feed consumer so it no longer protects retention')
    .argument('<consumer-id>').option('--json', 'print machine-readable JSON', false)
    .action((consumerId: string, options: { json: boolean }) => {
      publish(ctx, { mode: 'consumer-remove', consumerId: requiredText(consumerId, 'consumer-id'), json: options.json })
    })

  program.command('purge').description('Permanently remove bounded terminal Run bookkeeping protected by consumer cursors')
    .requiredOption('--before <RFC3339-or-epoch-ms>', 'exclusive terminal update cutoff', timestamp)
    .option('--limit <count>', 'maximum Runs to remove (maximum 1000)', positiveInteger, 100)
    .option('--confirm', 'confirm permanent automation bookkeeping removal', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { before: number; limit: number; confirm: boolean; json: boolean }) => {
      if (!options.confirm) program.error('error: purge requires --confirm')
      publish(ctx, { mode: 'purge', before: options.before, limit: options.limit, json: options.json })
    })
}

function registerQueueCommands(program: Command, ctx: Context): void {
  program.command('status').description('Check the automation store and print bounded queue health')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }) => { publish(ctx, { mode: 'status', json: options.json }) })

  program.command('pause').description('Pause new Run claims without interrupting active Attempts')
    .option('--reason <text>', 'bounded operator reason').option('--json', 'print machine-readable JSON', false)
    .action((options: { reason?: string; json: boolean }) => {
      publish(ctx, { mode: 'pause', json: options.json, ...(options.reason === undefined ? {} : { reason: requiredText(options.reason, '--reason') }) })
    })

  program.command('resume').description('Resume new Run claims').option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }) => { publish(ctx, { mode: 'resume', json: options.json }) })

  program.command('drain').description('Stop new claims and wait for active Attempts to finish')
    .option('--reason <text>', 'bounded operator reason')
    .option('--timeout-ms <milliseconds>', 'maximum wait before returning an error', positiveInteger, 30_000)
    .option('--poll-ms <milliseconds>', 'active Attempt polling interval', positiveInteger, 250)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { reason?: string; timeoutMs: number; pollMs: number; json: boolean }) => {
      publish(ctx, {
        mode: 'drain', timeoutMs: options.timeoutMs, pollMs: options.pollMs, json: options.json,
        ...(options.reason === undefined ? {} : { reason: requiredText(options.reason, '--reason') }),
      })
    })
}

function registerRunCommands(program: Command, ctx: Context): void {
  for (const mode of ['show', 'cancel'] as const) {
    program.command(mode).description(mode === 'show' ? 'Show one Run and its audit events' : 'Request Run cancellation')
      .argument('<run-id>').option('--json', 'print machine-readable JSON', false)
      .action((runId: string, options: { json: boolean }) => {
        publish(ctx, { mode, runId: requiredText(runId, 'run-id'), json: options.json })
      })
  }
  program.command('retry').description('Create a new Run from a failed, cancelled, or explicitly acknowledged indeterminate Run')
    .argument('<run-id>').option('--idempotency-key <key>', 'deduplicate this explicit retry request')
    .option('--confirm-indeterminate', 'acknowledge that unknown side effects may already exist', false)
    .option('--priority <integer>', 'replacement Run priority', safeInteger)
    .option('--max-attempts <integer>', 'replacement maximum Attempts', positiveInteger)
    .option('--json', 'print machine-readable JSON', false)
    .action((runId: string, options: {
      idempotencyKey?: string; confirmIndeterminate: boolean; priority?: number; maxAttempts?: number; json: boolean
    }) => {
      publish(ctx, {
        mode: 'retry', runId: requiredText(runId, 'run-id'), confirmIndeterminate: options.confirmIndeterminate, json: options.json,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: requiredText(options.idempotencyKey, '--idempotency-key') }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      })
    })
}

function publish(ctx: Context, startup: AutomationStartup): void {
  ctx.provide('automationStartup', startup)
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

function nonNegativeInteger(value: string): number {
  const parsed = safeInteger(value)
  if (parsed < 0) throw new Error('expected a non-negative integer')
  return parsed
}

function timestamp(value: string): number {
  if (/^\d+$/.test(value)) return nonNegativeInteger(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('expected RFC3339 or epoch milliseconds')
  }
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('expected a valid non-negative timestamp')
  return parsed
}

function requiredText(value: string, name: string): string {
  if (value.trim() === '') throw new Error(`${name} must not be empty`)
  return value
}
