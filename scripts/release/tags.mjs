import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isVersion, releasePackages, releaseVersion } from './packages.mjs'

export function planReleaseTags(version, versions, tags) {
  if (!isVersion(version)) throw new Error(`invalid release version ${JSON.stringify(version)}`)
  if (!versions.includes(version)) throw new Error(`${version} is not published`)

  const prerelease = version.includes('-')
  const desired = prerelease ? 'next' : 'latest'
  const operations = []
  if (tags[desired] !== version) operations.push({ action: 'add', tag: desired, version })

  if (prerelease && tags.latest?.includes('-')) {
    const stable = versions.filter(candidate => !candidate.includes('-')).sort(compareStableVersions).at(-1)
    if (stable === undefined) operations.push({ action: 'remove', tag: 'latest' })
    else operations.push({ action: 'add', tag: 'latest', version: stable })
  }
  return operations
}

export async function reconcileReleaseTags(version = releaseVersion()) {
  for (const { name } of releasePackages) {
    const versions = registryJson(['view', name, 'versions', '--json'])
    const normalizedVersions = Array.isArray(versions) ? versions : [versions]
    const tags = registryJson(['view', name, 'dist-tags', '--json'])
    const operations = planReleaseTags(version, normalizedVersions, tags)

    for (const operation of operations) {
      if (operation.action === 'add') {
        execFileSync('npm', ['dist-tag', 'add', `${name}@${operation.version}`, operation.tag], { stdio: 'inherit' })
      } else {
        execFileSync('npm', ['dist-tag', 'rm', name, operation.tag], { stdio: 'inherit' })
      }
    }
    await waitForTags(name, version)
    process.stdout.write(`dist-tags ok for ${name}@${version}\n`)
  }
}

function registryJson(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  return JSON.parse(result.stdout)
}

async function waitForTags(name, version) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const versions = registryJson(['view', name, 'versions', '--json'])
    const normalizedVersions = Array.isArray(versions) ? versions : [versions]
    const tags = registryJson(['view', name, 'dist-tags', '--json'])
    if (planReleaseTags(version, normalizedVersions, tags).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(`npm dist-tags for ${name}@${version} did not converge within 60 seconds`)
}

function compareStableVersions(left, right) {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const versionIndex = process.argv.indexOf('--version')
  const version = versionIndex === -1 ? releaseVersion() : process.argv[versionIndex + 1]
  if (version === undefined || !isVersion(version)) throw new Error('usage: node scripts/release/tags.mjs [--version <semver>]')
  await reconcileReleaseTags(version)
}
