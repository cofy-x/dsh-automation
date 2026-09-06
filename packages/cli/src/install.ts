import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { runDsh } from './runtime.ts'

const PROFILE = 'automation'

export interface InstallOptions {
  readonly profile: string
  readonly source: boolean
  readonly registry: boolean
  readonly serviceSpec?: string
  readonly appSpec?: string
}

export async function initialize(argv: readonly string[]): Promise<number> {
  const options = parseInstallOptions(argv)
  const specs = packageSpecs(options)
  const status = await runDsh(['plugin', '--profile', options.profile, 'add', '--save-exact', ...specs])
  if (status !== 0) return status
  process.stdout.write(`dsh-automation: profile ${options.profile} is configured\n`)
  return await runDsh(['--profile', options.profile, 'status'])
}

export function packageSpecs(options: InstallOptions, moduleDir = import.meta.dirname): readonly string[] {
  if (options.source && options.registry) throw new Error('--source and --registry cannot be used together')
  if ((options.serviceSpec === undefined) !== (options.appSpec === undefined)) {
    throw new Error('--service-spec and --app-spec must be supplied together')
  }
  if (options.serviceSpec !== undefined && (options.source || options.registry)) {
    throw new Error('explicit package specs cannot be combined with --source or --registry')
  }
  if (options.serviceSpec !== undefined && options.appSpec !== undefined) return [options.serviceSpec, options.appSpec]
  const root = resolve(moduleDir, '../../..')
  const sourceAvailable = isWorkspaceRoot(root)
  if (options.source && !sourceAvailable) throw new Error('--source requires a dsh-automation source checkout')
  if (options.source || (!options.registry && sourceAvailable)) {
    return [`link:${root}`, `link:${resolve(root, 'packages/app-bundle')}`]
  }
  const version = cliVersion(moduleDir)
  return [`dsh-automation@${version}`, `dsh-automation-app@${version}`]
}

function parseInstallOptions(argv: readonly string[]): InstallOptions {
  const command = new Command().name('dsh-automation init').exitOverride()
    .option('--profile <name>', 'DSH profile name', PROFILE)
    .option('--source', 'install this source checkout', false)
    .option('--registry', 'install the matching published packages', false)
    .option('--service-spec <spec>', 'advanced: core package path or registry spec')
    .option('--app-spec <spec>', 'advanced: application bundle path or registry spec')
  command.parse(['node', 'init', ...argv])
  const parsed = command.opts<{
    profile: string; source: boolean; registry: boolean; serviceSpec?: string; appSpec?: string
  }>()
  if (parsed.profile.trim() === '') throw new Error('--profile must not be empty')
  return {
    profile: parsed.profile,
    source: parsed.source,
    registry: parsed.registry,
    ...(parsed.serviceSpec === undefined ? {} : { serviceSpec: parsed.serviceSpec }),
    ...(parsed.appSpec === undefined ? {} : { appSpec: parsed.appSpec }),
  }
}

function isWorkspaceRoot(root: string): boolean {
  try {
    if (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) return false
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: unknown }
    return manifest.name === 'dsh-automation' && existsSync(resolve(root, 'packages/app-bundle/package.json'))
  } catch {
    return false
  }
}

function cliVersion(moduleDir: string): string {
  const manifest = JSON.parse(readFileSync(resolve(moduleDir, '../package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('dsh-automation-cli package version is missing')
  return manifest.version
}
