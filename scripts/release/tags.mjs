import { spawnSync } from 'node:child_process'
import { distTag, isVersion, releasePackages, releaseVersion } from './packages.mjs'

export function releaseTagFailures(version, versions, tags) {
  if (!isVersion(version)) throw new Error(`invalid release version ${JSON.stringify(version)}`)
  const failures = []
  if (!versions.includes(version)) failures.push(`${version} is not published`)

  const desired = distTag(version)
  if (tags[desired] !== version) failures.push(`${desired} must point to ${version}`)

  if (version.includes('-')) {
    const stableVersions = versions.filter(candidate => !candidate.includes('-'))
    if (stableVersions.length > 0 && (tags.latest === undefined || tags.latest.includes('-'))) {
      failures.push('latest must remain on a stable version')
    }
  }
  if (tags.latest !== undefined && !versions.includes(tags.latest)) {
    failures.push(`latest points to unpublished version ${tags.latest}`)
  }
  return failures
}

export async function verifyReleaseTags(version = releaseVersion()) {
  for (const { name } of releasePackages) {
    let failures = []
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const versions = registryJson(['view', name, 'versions', '--json'])
      const normalizedVersions = Array.isArray(versions) ? versions : [versions]
      const tags = registryJson(['view', name, 'dist-tags', '--json'])
      failures = releaseTagFailures(version, normalizedVersions, tags)
      if (failures.length === 0) break
      if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 5_000))
    }
    if (failures.length > 0) throw new Error(`invalid dist-tags for ${name}@${version}: ${failures.join('; ')}`)
    process.stdout.write(`dist-tags verified for ${name}@${version}\n`)
  }
}

function registryJson(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  return JSON.parse(result.stdout)
}
