import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packRelease } from './pack.mjs'
import { distTag, releaseVersion } from './packages.mjs'
import { verifyReleaseTags } from './tags.mjs'

const dryRun = process.argv.includes('--dry-run')
if (!dryRun) verifyCiReleaseContext()
const workspace = mkdtempSync(join(tmpdir(), 'dsh-automation-publish-'))
const artifacts = join(workspace, 'artifacts')
mkdirSync(artifacts)

try {
  const packages = packRelease(artifacts)
  const version = releaseVersion()
  const tag = distTag(version)
  process.stdout.write(`release order (${tag}): ${packages.map(item => item.name).join(' -> ')}\n`)
  for (const item of packages) {
    const existing = registryManifest(item.name, version)
    if (existing !== undefined) {
      verifyPublished(item, existing)
      process.stdout.write(`skip ${item.name}@${version}: already published\n`)
      continue
    }
    if (dryRun) {
      process.stdout.write(`dry-run: npm publish ${item.tarball} --access public --tag ${tag}\n`)
      continue
    }
    execFileSync('npm', ['publish', item.tarball, '--access', 'public', '--tag', tag], { stdio: 'inherit' })
    await waitForPackage(item)
  }
  if (!dryRun) {
    await verifyReleaseTags(version)
    await registrySmoke(version, workspace)
  } else {
    process.stdout.write('dry-run: registry dist-tags would be verified after all three publishes\n')
    process.stdout.write('dry-run: registry installation smoke would run after all three publishes\n')
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

function registryManifest(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, '--json'], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`
    if (diagnostic.includes('E404')) return undefined
    throw new Error(`npm view failed for ${name}@${version}: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
  return JSON.parse(result.stdout)
}

function verifyPublished(item, manifest) {
  if (manifest.name !== item.name || manifest.version !== item.version) {
    throw new Error(`registry returned unexpected metadata for ${item.name}@${item.version}`)
  }
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (repositoryUrl !== 'git+https://github.com/cofy-x/dsh-automation.git') {
    throw new Error(`${item.name}@${item.version} exists but does not belong to this repository`)
  }
  const localShasum = createHash('sha1').update(readFileSync(item.tarball)).digest('hex')
  if (manifest.dist?.shasum !== localShasum) {
    throw new Error(`${item.name}@${item.version} exists with different package bytes`)
  }
}

async function waitForPackage(item) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const manifest = registryManifest(item.name, item.version)
    if (manifest !== undefined) {
      verifyPublished(item, manifest)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(`${item.name}@${item.version} was published but did not become visible within 60 seconds`)
}

function verifyCiReleaseContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('real publication is restricted to the GitHub Actions release workflow')
  }
  const tag = process.env.RELEASE_TAG ?? `v${releaseVersion()}`
  const releaseSha = process.env.RELEASE_SHA
  if (releaseSha === undefined) throw new Error('RELEASE_SHA is required for publication')
  const root = join(import.meta.dirname, '../..')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (head !== releaseSha) throw new Error(`release checkout ${head} does not match ${releaseSha}`)
  execFileSync(process.execPath, [join(import.meta.dirname, 'check.mjs'), '--tag', tag, '--require-annotated-tag'], {
    stdio: 'inherit',
  })
}

async function registrySmoke(version, parent) {
  const consumer = join(parent, 'registry-consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.7.0' }, null, 2))
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), `packages:\n  - .\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': false\n  koffi: true\n  node-pty: true\n  protobufjs: false\n`)
  execFileSync('pnpm', ['add', '--save-exact', `dsh-automation-cli@${version}`], { cwd: consumer, stdio: 'inherit' })
  const cli = join(consumer, 'node_modules/dsh-automation-cli/lib/cli.js')
  const environment = { ...process.env, DSH_HOME: join(parent, 'registry-dsh-home') }
  execFileSync(process.execPath, [cli, 'init', '--registry'], { cwd: consumer, env: environment, stdio: 'inherit' })
  execFileSync(process.execPath, [cli, 'doctor'], { cwd: consumer, env: environment, stdio: 'inherit' })
  process.stdout.write(`registry installation smoke passed for ${version}\n`)
}
