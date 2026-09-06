import { Command } from 'commander'
import { captureDsh, captureExecutable, dshBin } from './runtime.ts'

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export function doctor(argv: readonly string[]): number {
  const command = new Command().name('dsh-automation doctor').exitOverride()
    .option('--profile <name>', 'DSH profile name', 'automation')
    .option('--json', 'print machine-readable diagnostics', false)
  command.parse(['node', 'doctor', ...argv])
  const options = command.opts<{ profile: string; json: boolean }>()
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const pnpm = captureExecutable('pnpm', ['--version'])
  const dsh = captureDsh(['--version'])
  const profile = captureDsh(['--profile', options.profile, 'status', '--json'])
  const checks: Check[] = [
    { name: 'node', ok: nodeMajor >= 24, detail: process.versions.node },
    { name: 'pnpm', ok: pnpm.status === 0, detail: output(pnpm) },
    { name: 'dsh', ok: dsh.status === 0, detail: output(dsh) || dshBin() },
    { name: 'profile', ok: profile.status === 0, detail: output(profile) },
  ]
  const ok = checks.every(check => check.ok)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, profile: options.profile, checks }, null, 2)}\n`)
  } else {
    for (const check of checks) process.stdout.write(`${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}\n`)
    if (!ok) process.stderr.write('dsh-automation: run `dsh-automation init` to create or repair the profile\n')
  }
  return ok ? 0 : 1
}

function output(result: { stdout: string; stderr: string }): string {
  return (result.stdout.trim() || result.stderr.trim()).replaceAll('\n', ' ')
}
