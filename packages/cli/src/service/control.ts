import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Command } from 'commander'
import { captureExecutable, runExecutable } from '../runtime.ts'
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  launchdDefinition,
  servicePaths,
  systemdDefinition,
  type ServiceOptions,
} from './config.ts'

export async function service(argv: readonly string[], executable: string): Promise<number> {
  const [action, ...rest] = argv
  switch (action) {
    case 'install': return await install(rest, executable)
    case 'start': return await start()
    case 'stop': return await stop()
    case 'restart': return await restart()
    case 'status': return await status()
    case 'logs': return await logs()
    case 'uninstall': return await uninstall()
    default:
      process.stderr.write('Usage: dsh-automation service <install|start|stop|restart|status|logs|uninstall>\n')
      return 2
  }
}

async function install(argv: readonly string[], executable: string): Promise<number> {
  const command = new Command().name('dsh-automation service install').exitOverride()
    .option('--dsh-home <path>', 'persistent DSH home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    .option('--profile <name>', 'DSH profile name', 'automation')
    .option('--slots <count>', 'parallel Worker slots', positiveInteger, 1)
    .option('--shutdown-grace-ms <milliseconds>', 'graceful shutdown wait', positiveInteger, 30_000)
    .option('--no-start', 'write and validate the definition without starting it')
  command.parse(['node', 'install', ...argv])
  const parsed = command.opts<{ dshHome: string; profile: string; slots: number; shutdownGraceMs: number; start: boolean }>()
  if (parsed.profile.trim() === '') throw new Error('--profile must not be empty')
  const options: ServiceOptions = {
    executable: resolve(executable),
    dshHome: resolve(parsed.dshHome),
    profile: parsed.profile,
    slots: parsed.slots,
    shutdownGraceMs: parsed.shutdownGraceMs,
  }
  const paths = servicePaths()
  mkdirSync(dirname(paths.definition), { recursive: true })
  if (paths.logDirectory !== undefined) mkdirSync(paths.logDirectory, { recursive: true })
  const definition = process.platform === 'darwin'
    ? launchdDefinition(options, paths.logDirectory ?? dirname(paths.definition))
    : systemdDefinition(options)
  writeFileSync(paths.definition, definition, { encoding: 'utf8', mode: 0o600 })
  const validation = await validate(paths.definition)
  if (validation !== 0 || !parsed.start) return validation
  return await start()
}

async function start(): Promise<number> {
  const paths = servicePaths()
  if (!existsSync(paths.definition)) {
    process.stderr.write('dsh-automation: service is not installed; run `dsh-automation service install`\n')
    return 1
  }
  if (process.platform === 'darwin') {
    const target = `${launchDomain()}/${LAUNCHD_LABEL}`
    const loaded = captureExecutable('launchctl', ['print', target]).status === 0
    if (!loaded) {
      const bootstrap = await runExecutable('launchctl', ['bootstrap', launchDomain(), paths.definition])
      if (bootstrap !== 0) return bootstrap
    }
    return await runExecutable('launchctl', ['kickstart', '-k', target])
  }
  await runExecutable('systemctl', ['--user', 'daemon-reload'])
  return await runExecutable('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
}

async function stop(): Promise<number> {
  if (process.platform === 'darwin') return await runExecutable('launchctl', ['bootout', `${launchDomain()}/${LAUNCHD_LABEL}`])
  return await runExecutable('systemctl', ['--user', 'stop', SYSTEMD_UNIT])
}

async function restart(): Promise<number> {
  if (process.platform === 'darwin') {
    await stop()
    return await start()
  }
  return await runExecutable('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
}

async function status(): Promise<number> {
  if (process.platform === 'darwin') return await runExecutable('launchctl', ['print', `${launchDomain()}/${LAUNCHD_LABEL}`])
  return await runExecutable('systemctl', ['--user', 'status', SYSTEMD_UNIT])
}

async function logs(): Promise<number> {
  const paths = servicePaths()
  if (process.platform === 'darwin') {
    return await runExecutable('tail', ['-F', join(paths.logDirectory ?? '', 'worker.log'), join(paths.logDirectory ?? '', 'worker.error.log')])
  }
  return await runExecutable('journalctl', ['--user', '-u', SYSTEMD_UNIT, '-f'])
}

async function uninstall(): Promise<number> {
  const paths = servicePaths()
  if (existsSync(paths.definition)) {
    await stop()
    rmSync(paths.definition)
  }
  if (process.platform === 'linux') await runExecutable('systemctl', ['--user', 'daemon-reload'])
  process.stdout.write(`dsh-automation: removed ${paths.definition}\n`)
  return 0
}

async function validate(definition: string): Promise<number> {
  if (process.platform === 'darwin') return await runExecutable('plutil', ['-lint', definition])
  return await runExecutable('systemd-analyze', ['--user', 'verify', definition])
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('expected a positive integer')
  return parsed
}
