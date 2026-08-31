import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/startup.ts'

function parse(args: string[]) {
  const ctx = new Context()
  let exitCode: number | undefined
  provideCmdline(ctx, { args, exit: code => { exitCode = code } })
  apply(ctx)
  return { startup: ctx.get('automationStartup'), exitCode }
}

describe('automation startup command', () => {
  it('publishes a normalized submit command', () => {
    const { startup, exitCode } = parse([
      'submit', '--cwd', '/workspace', '--provider', 'deepseek-official', '--model', 'deepseek-v4',
      '--permission', 'workspace-write', '--priority', '4', '--max-attempts', '2', 'inspect', 'the', 'tests',
    ])
    expect(exitCode).toBeUndefined()
    expect(startup).toEqual({
      mode: 'submit',
      prompt: 'inspect the tests',
      cwd: '/workspace',
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      permissionPreset: 'workspace-write',
      priority: 4,
      maxAttempts: 2,
      json: false,
    })
  })

  it('publishes manual concurrency and bounded reconciliation queries', () => {
    expect(parse(['submit', '--cwd', '/workspace', '--concurrency-key', 'repo:cofy-x/dsh', '--concurrency-limit', '2', 'run'])).toMatchObject({
      startup: { mode: 'submit', concurrencyKey: 'repo:cofy-x/dsh', concurrencyLimit: 2 }, exitCode: undefined,
    })
    expect(parse([
      'list', '--state', 'failed', '--trigger-kind', 'cron', '--trigger-source', 'nightly', '--limit', '20',
      '--before-created-at', '100', '--before-id', 'run-old', '--json',
    ])).toEqual({
      startup: {
        mode: 'list', state: 'failed', triggerKind: 'cron', triggerSourceId: 'nightly', limit: 20,
        beforeCreatedAt: 100, beforeId: 'run-old', json: true,
      },
      exitCode: undefined,
    })
    expect(parse(['events', '--after-seq', '42', '--trigger-kind', 'webhook', '--limit', '10', '--json'])).toEqual({
      startup: { mode: 'events', afterSeq: 42, triggerKind: 'webhook', limit: 10, json: true }, exitCode: undefined,
    })
  })

  it('publishes event-consumer and confirmed retention commands', () => {
    expect(parse(['consumer-checkpoint', 'cron.reconciler', '42', '--json'])).toEqual({
      startup: { mode: 'consumer-checkpoint', consumerId: 'cron.reconciler', seq: 42, json: true }, exitCode: undefined,
    })
    expect(parse(['consumer-remove', 'cron.reconciler'])).toEqual({
      startup: { mode: 'consumer-remove', consumerId: 'cron.reconciler', json: false }, exitCode: undefined,
    })
    expect(parse(['purge', '--before', '2026-09-01T00:00:00Z', '--limit', '25', '--confirm', '--json'])).toEqual({
      startup: { mode: 'purge', before: 1788220800000, limit: 25, json: true }, exitCode: undefined,
    })
  })

  it('rejects an unsafe Worker heartbeat/lease relationship', () => {
    const original = internals.stderr
    let diagnostic = ''
    internals.stderr = { write: (text: string) => { diagnostic += text } }
    try {
      const { startup, exitCode } = parse(['worker', '--poll-ms', '1000', '--lease-ms', '3000'])
      expect(startup).toBeUndefined()
      expect(exitCode).toBe(1)
      expect(diagnostic).toContain('--lease-ms must be greater than three polling intervals')
    } finally {
      internals.stderr = original
    }
  })

  it('publishes a bounded machine-readable Worker cycle', () => {
    const { startup, exitCode } = parse([
      'worker', '--once', '--json', '--worker-id', 'supervisor-probe', '--poll-ms', '500', '--lease-ms', '5000',
    ])

    expect(exitCode).toBeUndefined()
    expect(startup).toEqual({
      mode: 'worker',
      pollMs: 500,
      leaseMs: 5000,
      slots: 1,
      shutdownGraceMs: 30000,
      workerId: 'supervisor-probe',
      once: true,
      json: true,
    })
  })

  it('publishes the bounded store status command', () => {
    const { startup, exitCode } = parse(['status', '--json'])

    expect(exitCode).toBeUndefined()
    expect(startup).toEqual({ mode: 'status', json: true })
  })

  it('publishes durable queue pause and resume commands', () => {
    expect(parse(['pause', '--reason', 'planned upgrade', '--json'])).toEqual({
      startup: { mode: 'pause', reason: 'planned upgrade', json: true }, exitCode: undefined,
    })
    expect(parse(['resume'])).toEqual({ startup: { mode: 'resume', json: false }, exitCode: undefined })
    expect(parse(['drain', '--reason', 'deploy', '--timeout-ms', '5000', '--poll-ms', '50', '--json'])).toEqual({
      startup: { mode: 'drain', reason: 'deploy', timeoutMs: 5000, pollMs: 50, json: true }, exitCode: undefined,
    })
  })

  it('publishes an explicitly acknowledged retry command', () => {
    expect(parse(['retry', 'run-old', '--idempotency-key', 'operator-1', '--confirm-indeterminate', '--json'])).toEqual({
      startup: {
        mode: 'retry', runId: 'run-old', idempotencyKey: 'operator-1', confirmIndeterminate: true, json: true,
      },
      exitCode: undefined,
    })
  })

  it('rejects JSON output for a long-lived Worker', () => {
    const original = internals.stderr
    let diagnostic = ''
    internals.stderr = { write: (text: string) => { diagnostic += text } }
    try {
      const { startup, exitCode } = parse(['worker', '--json'])
      expect(startup).toBeUndefined()
      expect(exitCode).toBe(1)
      expect(diagnostic).toContain('worker --json requires --once')
    } finally {
      internals.stderr = original
    }
  })
})
