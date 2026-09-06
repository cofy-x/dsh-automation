import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

function manifest(path: string): {
  name: string
  version: string
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
})
