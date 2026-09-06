import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isVersion, releasePackages, root } from './packages.mjs'

const version = process.argv.slice(2).find(argument => argument !== '--')
if (version === undefined || !isVersion(version)) throw new Error('usage: pnpm release:version -- <semver>')

const current = releasePackages.map(item => JSON.parse(readFileSync(item.manifestPath, 'utf8')))
for (const [index, item] of releasePackages.entries()) {
  const manifest = current[index]
  manifest.version = version
  if (item.role === 'app') manifest.peerDependencies['dsh-automation'] = version
  if (item.role === 'cli') {
    manifest.dependencies['dsh-automation'] = `workspace:${version}`
    manifest.dependencies['dsh-automation-app'] = `workspace:${version}`
  }
  writeFileSync(item.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' })
process.stdout.write(`updated all automation packages to ${version}\n`)
