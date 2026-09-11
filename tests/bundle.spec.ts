import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

function manifest(path: string): {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
} {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

describe('bundle boundaries', () => {
  it('keeps the default package composable as a service-only bundle', () => {
    const packageManifest = manifest('package.json')
    const patch = readFileSync(resolve(root, packageManifest.dsh?.bundle?.patch ?? ''), 'utf8')

    expect(packageManifest.name).toBe('dsh-automation')
    expect(patch).toContain('id: dsh-automation\n')
    expect(patch).not.toContain('id: dsh-automation-startup')
    expect(patch).not.toContain('id: dsh-automation-app')
  })

  it('isolates process command parsing in the companion app bundle', () => {
    const rootManifest = manifest('package.json')
    const packageManifest = manifest('packages/app-bundle/package.json')
    const packageRoot = resolve(root, 'packages/app-bundle')
    const patch = readFileSync(resolve(packageRoot, packageManifest.dsh?.bundle?.patch ?? ''), 'utf8')

    expect(packageManifest.name).toBe('dsh-automation-app')
    expect(packageManifest.peerDependencies?.['dsh-automation']).toBe(rootManifest.version)
    expect(patch).toContain('id: dsh-automation-startup')
    expect(patch).toContain('id: dsh-automation-app')
    expect(patch).not.toContain('id: dsh-automation\n')
  })

  it('targets one coordinated DSH release across runtime, tests, and the installed profile', () => {
    const packageManifest = manifest('package.json')
    const cliManifest = manifest('packages/cli/package.json')
    const dshPeers = Object.entries(packageManifest.peerDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    const testProfile = Object.entries(packageManifest.devDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    const installedProfile = Object.entries(cliManifest.dependencies ?? {})
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

    expect(dshPeers.length).toBeGreaterThan(0)
    expect(testProfile.length).toBeGreaterThan(0)
    expect(installedProfile.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      expect(range, name).toBe('>=0.1.5-rc.1 <0.2.0')
    }
    for (const [name, version] of [...testProfile, ...installedProfile]) {
      expect(version, name).toBe('0.1.5-rc.1')
    }
  })
})
