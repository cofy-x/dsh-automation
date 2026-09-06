import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const LAUNCHD_LABEL = 'com.cofy-x.dsh-automation'
export const SYSTEMD_UNIT = 'dsh-automation.service'

export interface ServiceOptions {
  readonly executable: string
  readonly dshHome: string
  readonly profile: string
  readonly slots: number
  readonly shutdownGraceMs: number
}

export interface ServicePaths {
  readonly definition: string
  readonly logDirectory?: string
}

export function servicePaths(platform = process.platform, home = homedir()): ServicePaths {
  if (platform === 'darwin') {
    return {
      definition: join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`),
      logDirectory: join(home, '.dsh/automation/logs'),
    }
  }
  if (platform === 'linux') return { definition: join(home, '.config/systemd/user', SYSTEMD_UNIT) }
  throw new Error(`service management is not supported on ${platform}; run \`dsh-automation start\` under your supervisor`)
}

export function launchdDefinition(options: ServiceOptions, logDirectory: string): string {
  const argumentsXml = workerArguments(options).map(value => `    <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>DSH_HOME</key><string>${xml(options.dshHome)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(join(logDirectory, 'worker.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory, 'worker.error.log'))}</string>
</dict>
</plist>
`
}

export function systemdDefinition(options: ServiceOptions): string {
  const command = workerArguments(options).map(systemdEscape).join(' ')
  return `[Unit]
Description=DeepSeek Harness durable automation Worker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
Environment="DSH_HOME=${systemdEnvironmentEscape(options.dshHome)}"
ExecStart=${command}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=${Math.ceil(options.shutdownGraceMs / 1_000) + 30}

[Install]
WantedBy=default.target
`
}

function workerArguments(options: ServiceOptions): readonly string[] {
  return [
    process.execPath,
    resolve(options.executable),
    'start',
    '--profile', options.profile,
    '--slots', String(options.slots),
    '--shutdown-grace-ms', String(options.shutdownGraceMs),
  ]
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function systemdEscape(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

function systemdEnvironmentEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
}
