import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profile, withoutProfile } from '../packages/cli/src/arguments.ts'
import { packageSpecs } from '../packages/cli/src/install.ts'
import { launchdDefinition, servicePaths, systemdDefinition } from '../packages/cli/src/service/config.ts'

describe('standalone CLI installation', () => {
  it('uses the source checkout when running from the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-automation-cli-'))
    mkdirSync(join(root, 'packages/app-bundle'), { recursive: true })
    mkdirSync(join(root, 'packages/cli/src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-automation' }))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(join(root, 'packages/app-bundle/package.json'), '{}')
    writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({ version: '0.2.0-alpha.0' }))

    expect(packageSpecs({ profile: 'automation', source: false, registry: false }, join(root, 'packages/cli/src')))
      .toEqual([`link:${root}`, `link:${join(root, 'packages/app-bundle')}`])
  })

  it('pins matching registry packages', () => {
    expect(packageSpecs({ profile: 'automation', source: false, registry: true }, join(import.meta.dirname, '../packages/cli/src')))
      .toEqual(['dsh-automation@0.2.0-alpha.0', 'dsh-automation-app@0.2.0-alpha.0'])
  })

  it('accepts an explicit pair of release artifacts', () => {
    expect(packageSpecs({
      profile: 'automation', source: false, registry: false, serviceSpec: '/tmp/core.tgz', appSpec: '/tmp/app.tgz',
    })).toEqual(['/tmp/core.tgz', '/tmp/app.tgz'])
  })
})

describe('profile forwarding', () => {
  it('preserves an ordinary application command', () => {
    expect(profile(['worker', '--once', '--json'])).toBe('automation')
    expect(withoutProfile(['worker', '--once', '--json'])).toEqual(['worker', '--once', '--json'])
  })

  it('extracts either profile option spelling', () => {
    expect(profile(['status', '--profile', 'nightly'])).toBe('nightly')
    expect(withoutProfile(['status', '--profile', 'nightly'])).toEqual(['status'])
    expect(profile(['--profile=nightly', 'status'])).toBe('nightly')
    expect(withoutProfile(['--profile=nightly', 'status'])).toEqual(['status'])
  })
})

describe('service definitions', () => {
  const options = {
    executable: '/opt/dsh automation/cli.js', dshHome: '/srv/dsh&home', profile: 'nightly', slots: 3, shutdownGraceMs: 45_000,
  }

  it('renders a launchd definition with a stable foreground command', () => {
    const definition = launchdDefinition(options, '/tmp/dsh logs')
    expect(definition).toContain('<string>/opt/dsh automation/cli.js</string>')
    expect(definition).toContain('<string>--slots</string>\n    <string>3</string>')
    expect(definition).toContain('<string>--profile</string>\n    <string>nightly</string>')
    expect(definition).toContain('/srv/dsh&amp;home')
  })

  it('renders a systemd user unit with restart and shutdown policy', () => {
    const definition = systemdDefinition(options)
    expect(definition).toContain('ExecStart=')
    expect(definition).toContain('"/opt/dsh automation/cli.js"')
    expect(definition).toContain('"--profile" "nightly"')
    expect(definition).toContain('Restart=on-failure')
    expect(definition).toContain('TimeoutStopSec=75')
  })

  it('uses user-owned service locations', () => {
    expect(servicePaths('darwin', '/Users/test').definition).toBe('/Users/test/Library/LaunchAgents/com.cofy-x.dsh-automation.plist')
    expect(servicePaths('linux', '/home/test').definition).toBe('/home/test/.config/systemd/user/dsh-automation.service')
  })
})
