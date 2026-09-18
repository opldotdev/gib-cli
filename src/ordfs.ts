/**
 * ORDFS client — the read path.
 *
 * api.1sat.app serves ORDFS content from mempool, so unpublished-in-block
 * state resolves immediately. Directory manifests must be requested with
 * ?raw=1: without it the server treats a bare directory outpoint as a
 * website root and tries to resolve a default entry (routes.go).
 */

export const ORDFS_BASE = 'https://api.1sat.app/content'

export type Outpoint = string // txid_vout

export function splitOutpoint(op: Outpoint): { txid: string; vout: number } {
  const [txid, vout] = op.split('_')
  if (!txid || vout === undefined) throw new Error(`bad outpoint: ${op}`)
  return { txid, vout: Number(vout) }
}

export function isDirectoryPointer(target: string): boolean {
  // manifest values are "_N" leaf pointers; a directory child would be a
  // full outpoint of another tx OR an "_N" whose content is itself a
  // directory JSON. The distinction is made by content-type at fetch time.
  return target.startsWith('_')
}

/** Resolve a child "_N" of a root into a full outpoint. */
export function childOutpoint(root: Outpoint, child: string): Outpoint {
  const { txid } = splitOutpoint(root)
  return `${txid}${child}`
}

export async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`ORDFS ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`)
  }
  return { text: await res.text(), contentType: res.headers.get('content-type') ?? '' }
}

/** Fetch a directory manifest (ord-fs/json) by outpoint. */
export async function fetchManifest(op: Outpoint): Promise<Record<string, string>> {
  const { text } = await fetchText(`${ORDFS_BASE}/${op}?raw=1`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`not a directory manifest at ${op}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`not a directory manifest at ${op}`)
  }
  const dir = parsed as Record<string, string>
  // values must all be "_N" pointers within one tx
  for (const [k, v] of Object.entries(dir)) {
    if (typeof v !== 'string' || !v.startsWith('_')) {
      throw new Error(`unexpected manifest entry at ${op}: ${k} -> ${v}`)
    }
  }
  return dir
}

export function isManifestContent(contentType: string): boolean {
  return contentType.includes('ord-fs') || contentType.includes('application/json')
}

/**
 * Walk a directory tree from a root outpoint, returning every file as
 * path → bytes, recursing into child manifests by sniffing content-type.
 */
export async function fetchTree(
  root: Outpoint,
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const out: Array<{ path: string; bytes: Uint8Array }> = []
  const walk = async (op: Outpoint, prefix: string) => {
    const dir = await fetchManifest(op)
    for (const [name, ptr] of Object.entries(dir).sort()) {
      const child = childOutpoint(op, ptr)
      const { txid } = splitOutpoint(op)
      const childOp = `${txid}${ptr}`
      // raw=1 is a no-op for leaf content (the server only consults it in
      // the directory branch), and required for nested directory manifests.
      const { text } = await fetchText(`${ORDFS_BASE}/${childOp}?raw=1`)
      if (looksLikeManifest(text)) {
        await walk(childOp, `${prefix}${name}/`)
      } else {
        out.push({ path: `${prefix}${name}`, bytes: new TextEncoder().encode(text) })
      }
    }
  }
  await walk(root, '')
  return out
}

function looksLikeManifest(text: string): boolean {
  try {
    const p = JSON.parse(text)
    return (
      typeof p === 'object' && p !== null && !Array.isArray(p) &&
      Object.values(p).every((v) => typeof v === 'string' && v.startsWith('_'))
    )
  } catch {
    return false
  }
}

/** Fetch raw content of any outpoint (no path resolution). */
export async function fetchContent(op: Outpoint): Promise<Uint8Array> {
  const { text } = await fetchText(`${ORDFS_BASE}/${op}`)
  return new TextEncoder().encode(text)
}
