import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const PACKAGE_NAME = 'dsh-automation'
const REPOSITORY = 'cofy-x/dsh-automation'
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function run(command, args, cwd) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

const ref = argument('--ref')
if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('Git-install smoke ref must be an exact commit')

const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const workspace = mkdtempSync(join(tmpdir(), `${PACKAGE_NAME}-git-smoke-`))
try {
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: expected.packageManager }, null, 2))
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'allowBuilds:',
    `  '${PACKAGE_NAME}@https://codeload.github.com/${REPOSITORY}/tar.gz/${ref}': true`,
    '',
  ].join('\n'))
  run('pnpm', ['add', '--save-exact', `github:${REPOSITORY}#${ref}`], workspace)

  const require = createRequire(join(workspace, 'smoke.cjs'))
  const entry = require.resolve(PACKAGE_NAME)
  const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
  if (manifest.version !== expected.version) throw new Error(`installed version ${manifest.version} does not match ${expected.version}`)
  const automation = await import(`${pathToFileURL(entry).href}?smoke=${Date.now()}`)
  if (typeof automation.default !== 'function' || typeof automation.AutomationService !== 'function') {
    throw new Error('installed package omitted its public runtime exports')
  }
  console.log(`${PACKAGE_NAME} Git-install smoke passed for ${ref}`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
