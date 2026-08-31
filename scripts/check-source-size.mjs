import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_LINES = 300
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return await sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  }))
  return nested.flat()
}

const oversized = []
for (const path of await sourceFiles(sourceRoot)) {
  const lines = (await readFile(path, 'utf8')).split('\n').length - 1
  if (lines > MAX_LINES) oversized.push(`${relative(sourceRoot, path)}: ${lines} lines`)
}

if (oversized.length > 0) {
  throw new Error(`source modules must stay at or below ${MAX_LINES} lines:\n${oversized.join('\n')}`)
}
