import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packRelease } from './pack.mjs'
import { releaseVersion } from './packages.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-automation-release-'))
const artifacts = join(workspace, 'artifacts')
const consumer = join(workspace, 'consumer')

try {
  mkdirSync(artifacts)
  mkdirSync(consumer)
  const packages = packRelease(artifacts)
  const core = packages.find(item => item.role === 'core').tarball
  const app = packages.find(item => item.role === 'app').tarball
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    private: true,
    packageManager: 'pnpm@11.7.0',
  }, null, 2), {
    flag: 'wx',
  })
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), `packages:\n  - .\noverrides:\n  dsh-automation: ${JSON.stringify(core)}\n  dsh-automation-app: ${JSON.stringify(app)}\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': false\n  koffi: true\n  node-pty: true\n  protobufjs: false\n`)
  run('pnpm', ['add', '--save-exact', ...packages.map(item => item.tarball)], consumer)

  const cli = join(consumer, 'node_modules/dsh-automation-cli/lib/cli.js')
  const version = run(process.execPath, [cli, '--version'], consumer).trim()
  if (version !== releaseVersion()) throw new Error(`packed CLI reported version ${version}`)

  const environment = { ...process.env, DSH_HOME: join(workspace, 'dsh-home') }
  run(process.execPath, [cli, 'init', '--service-spec', core, '--app-spec', app], consumer, environment)
  const health = JSON.parse(run(process.execPath, [cli, 'doctor', '--json'], consumer, environment))
  if (health.ok !== true) throw new Error('packed CLI installation is not healthy')
  const profile = JSON.parse(readFileSync(join(environment.DSH_HOME, 'profiles/automation/package.json'), 'utf8'))
  if (profile.dependencies?.['dsh-automation'] === undefined) throw new Error('packed core is missing from the profile')
  if (profile.dependencies?.['dsh-automation-app'] === undefined) throw new Error('packed app is missing from the profile')
  process.stdout.write(`release artifact smoke passed for ${releaseVersion()}\n`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

function run(command, args, cwd, env = process.env) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  return execFileSync(executable, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}
