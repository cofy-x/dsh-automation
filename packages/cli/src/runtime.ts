import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)

export interface CapturedCommand {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export function dshBin(): string {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: { dsh?: unknown } }
  if (typeof manifest.bin?.dsh !== 'string') throw new Error('@deepseek-ai/dsh does not expose its dsh executable')
  return resolve(dirname(manifestPath), manifest.bin.dsh)
}

export async function runDsh(args: readonly string[]): Promise<number> {
  return await runNode(dshBin(), args)
}

export function captureDsh(args: readonly string[]): CapturedCommand {
  const result = spawnSync(process.execPath, [dshBin(), ...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export function captureExecutable(command: string, args: readonly string[]): CapturedCommand {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 127, stdout: '', stderr: `${command} was not found on PATH` }
    throw result.error
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

export async function runExecutable(command: string, args: readonly string[]): Promise<number> {
  const executable = process.platform === 'win32' && command.endsWith('pnpm') ? `${command}.cmd` : command
  return await new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => accept(code ?? signalExitCode(signal)))
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    const forwardInterrupt = (): void => forward('SIGINT')
    const forwardTerminate = (): void => forward('SIGTERM')
    process.once('SIGINT', forwardInterrupt)
    process.once('SIGTERM', forwardTerminate)
    child.once('close', () => {
      process.removeListener('SIGINT', forwardInterrupt)
      process.removeListener('SIGTERM', forwardTerminate)
    })
  })
}

async function runNode(entry: string, args: readonly string[]): Promise<number> {
  return await runExecutable(process.execPath, [entry, ...args])
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}
