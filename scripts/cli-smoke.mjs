import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const entry = join(root, 'packages/cli/lib/cli.js')
const workspace = mkdtempSync(join(tmpdir(), 'dsh-automation-cli-smoke-'))
const environment = { ...process.env, DSH_HOME: join(workspace, 'home') }

function run(args) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, env: environment, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`dsh-automation ${args.join(' ')} exited ${result.status}`)
  }
  return result.stdout
}

try {
  run(['init', '--source'])
  const diagnostics = JSON.parse(run(['doctor', '--json']))
  if (diagnostics.ok !== true) throw new Error('doctor did not report a healthy installation')
  const cycle = JSON.parse(run(['worker', '--once', '--json']))
  if (cycle.recovered !== 0 || !Array.isArray(cycle.claimedRunIds)) throw new Error('bounded Worker result is invalid')

  const profile = JSON.parse(readFileSync(join(environment.DSH_HOME, 'profiles/automation/package.json'), 'utf8'))
  if (typeof profile.dependencies?.['dsh-automation'] !== 'string') throw new Error('service bundle is missing from profile')
  if (typeof profile.dependencies?.['dsh-automation-app'] !== 'string') throw new Error('application bundle is missing from profile')
  process.stdout.write('dsh-automation standalone CLI smoke passed\n')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
