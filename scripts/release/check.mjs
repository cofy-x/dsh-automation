import { execFileSync } from 'node:child_process'
import { manifests, releaseVersion, repository, root } from './packages.mjs'

const expectedTag = argument('--tag')
const requireTag = process.argv.includes('--require-annotated-tag')
const packages = manifests()
const version = releaseVersion()
const failures = []

for (const { role, name, manifest } of packages) {
  expect(manifest.name === name, `${role} package name must be ${name}`)
  expect(manifest.version === version, `${name} version must be ${version}`)
  expect(manifest.publishConfig?.access === 'public', `${name} must publish with public access`)
  expect(manifest.repository?.url === repository, `${name} repository must be ${repository}`)
  expect(manifest.private !== true, `${name} must not be private`)
}

const app = packages.find(item => item.role === 'app').manifest
const cli = packages.find(item => item.role === 'cli').manifest
expect(app.peerDependencies?.['dsh-automation'] === version, 'app must peer-depend on the exact core version')
expect(cli.dependencies?.['dsh-automation'] === `workspace:${version}`, 'CLI must depend on the exact workspace core version')
expect(cli.dependencies?.['dsh-automation-app'] === `workspace:${version}`, 'CLI must depend on the exact workspace app version')
expect(cli.bin?.['dsh-automation'] === 'lib/cli.js', 'CLI must expose the dsh-automation executable')

if (expectedTag !== undefined) expect(expectedTag === `v${version}`, `tag must be v${version}, received ${expectedTag}`)
if (requireTag) verifyReleaseTag(expectedTag, version)

if (failures.length > 0) throw new Error(`release contract failed:\n- ${failures.join('\n- ')}`)
process.stdout.write(`release contract ok: ${packages.map(item => `${item.name}@${version}`).join(', ')}\n`)

function expect(condition, message) {
  if (!condition) failures.push(message)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function verifyReleaseTag(tag, version) {
  if (tag === undefined) throw new Error('--require-annotated-tag requires --tag')
  expect(tag === `v${version}`, `release tag must match package version v${version}`)
  const type = git(['cat-file', '-t', `refs/tags/${tag}`])
  expect(type === 'tag', `${tag} must be an annotated tag`)
  const taggedCommit = git(['rev-parse', `${tag}^{commit}`])
  const head = git(['rev-parse', 'HEAD'])
  expect(taggedCommit === head, `${tag} must point to checked-out HEAD`)
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, 'origin/main'], { cwd: root, stdio: 'ignore' })
  } catch {
    failures.push(`${tag} commit must be reachable from origin/main`)
  }
  expect(git(['status', '--porcelain']) === '', 'release checkout must be clean')
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}
