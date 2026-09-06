#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { profile, withoutProfile } from './arguments.ts'
import { doctor } from './doctor.ts'
import { initialize } from './install.ts'
import { runDsh } from './runtime.ts'
import { service } from './service/control.ts'

const argv = process.argv.slice(2)
const command = argv[0]
const rest = argv.slice(1)

try {
  let exitCode: number
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      help()
      exitCode = 0
      break
    case '--version':
    case '-V':
      process.stdout.write(`${version()}\n`)
      exitCode = 0
      break
    case 'init':
      exitCode = await initialize(rest)
      break
    case 'doctor':
      exitCode = doctor(rest)
      break
    case 'start':
      exitCode = await runDsh(['--profile', profile(rest), 'worker', ...withoutProfile(rest)])
      break
    case 'service':
      exitCode = await service(rest, process.argv[1] ?? '')
      break
    default:
      exitCode = await runDsh(['--profile', profile(argv), ...withoutProfile(argv)])
  }
  process.exitCode = exitCode
} catch (error) {
  process.stderr.write(`dsh-automation: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function version(): string {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

function help(): void {
  process.stdout.write(`Usage: dsh-automation <command> [options]

Set up and operate durable DeepSeek Harness automation.

Setup and service lifecycle:
  init                 create or repair the dedicated DSH profile
  doctor               verify runtime, profile, and durable storage
  start                run the Worker in the foreground
  service install      install and start a launchd/systemd user service
  service start|stop|restart|status|logs|uninstall

Automation commands:
  submit <prompt...>    persist a task for a Worker
  status               inspect queue and Worker state
  list | show | cancel | retry | events | pause | drain | resume
  consumers | purge

Use --profile <name> to override the default "automation" profile.
Automation command options are passed directly to the installed application.
`)
}
