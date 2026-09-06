import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '../..')
export const repository = 'git+https://github.com/cofy-x/dsh-automation.git'

export const releasePackages = [
  { role: 'core', name: 'dsh-automation', directory: root, manifestPath: resolve(root, 'package.json') },
  {
    role: 'app',
    name: 'dsh-automation-app',
    directory: resolve(root, 'packages/app-bundle'),
    manifestPath: resolve(root, 'packages/app-bundle/package.json'),
  },
  {
    role: 'cli',
    name: 'dsh-automation-cli',
    directory: resolve(root, 'packages/cli'),
    manifestPath: resolve(root, 'packages/cli/package.json'),
  },
]

export function manifests() {
  return releasePackages.map(item => ({
    ...item,
    manifest: JSON.parse(readFileSync(item.manifestPath, 'utf8')),
  }))
}

export function releaseVersion() {
  const versions = new Set(manifests().map(item => item.manifest.version))
  if (versions.size !== 1) throw new Error(`package versions differ: ${[...versions].join(', ')}`)
  const [version] = versions
  if (typeof version !== 'string' || !isVersion(version)) throw new Error(`invalid release version ${JSON.stringify(version)}`)
  return version
}

export function distTag(version) {
  return version.includes('-') ? 'next' : 'latest'
}

export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
}

export function isVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
}
