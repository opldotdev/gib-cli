/**
 * Directory walk: turn a folder on disk into deployOrdfsDir file entries.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface GibFileEntry {
  path: string
  base64Content: string
  contentType: string
}

const SKIP_DIRS = new Set(['.git', '.gib', 'node_modules'])

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}

function walk(dir: string, prefix = ''): Array<{ relPath: string; absPath: string }> {
  const found: Array<{ relPath: string; absPath: string }> = []
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      found.push(...walk(abs, `${prefix}${name}/`))
    } else if (st.isFile()) {
      found.push({ relPath: `${prefix}${name}`.split(sep).join('/'), absPath: abs })
    }
  }
  return found
}

/** Files in deterministic (sorted) order — output layout must be reproducible. */
export function collectDir(dir: string): GibFileEntry[] {
  return walk(dir).map(({ relPath, absPath }) => ({
    path: relPath,
    base64Content: readFileSync(absPath).toString('base64'),
    contentType: contentTypeFor(relPath),
  }))
}
