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
})
