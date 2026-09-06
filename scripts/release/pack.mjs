import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { releasePackages, releaseVersion, root, tarballName } from './packages.mjs'

export function packRelease(destination) {
  const version = releaseVersion()
  return releasePackages.map(item => {
    execFileSync('pnpm', ['--filter', item.name, 'pack', '--pack-destination', destination], {
      cwd: root,
      stdio: 'inherit',
    })
    return { ...item, version, tarball: join(destination, tarballName(item.name, version)) }
  })
}
