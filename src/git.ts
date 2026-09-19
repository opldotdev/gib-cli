import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function gitHash(type: 'blob' | 'tree' | 'commit' | 'tag', body: Uint8Array): string {
	const header = new TextEncoder().encode(`${type} ${body.length}\0`)
	const buf = new Uint8Array(header.length + body.length)
	buf.set(header)
	buf.set(body, header.length)
	return createHash('sha1').update(buf).digest('hex')
}

export async function writeGitObject(
	gitDir: string,
	type: 'blob' | 'tree' | 'commit' | 'tag',
	body: Uint8Array,
): Promise<string> {
	const sha = gitHash(type, body)
	const path = join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2))
	const { deflateSync } = await import('node:zlib')
	const header = new TextEncoder().encode(`${type} ${body.length}\0`)
	const raw = new Uint8Array(header.length + body.length)
	raw.set(header)
	raw.set(body, header.length)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, deflateSync(raw))
	return sha
}

export function treeEntryMode(opts: { exec?: boolean; symlink?: boolean; dir?: boolean }): string {
	if (opts.dir) return '40000'
	if (opts.symlink) return '120000'
	if (opts.exec) return '100755'
	return '100644'
}

function gitSortKey(mode: string, name: string): Uint8Array {
	return new TextEncoder().encode(mode === '40000' ? `${name}/` : name)
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) return a[i] - b[i]
	}
	return a.length - b.length
}

export function encodeTree(entries: Array<{ mode: string; name: string; sha: string }>): Uint8Array {
	const sorted = [...entries].sort((a, b) =>
		compareBytes(gitSortKey(a.mode, a.name), gitSortKey(b.mode, b.name)),
	)
	const parts: Uint8Array[] = []
	let n = 0
	for (const e of sorted) {
		const name = new TextEncoder().encode(`${e.mode} ${e.name}\0`)
		const sha = hexTo20(e.sha)
		const row = new Uint8Array(name.length + 20)
		row.set(name)
		row.set(sha, name.length)
		parts.push(row)
		n += row.length
	}
	const out = new Uint8Array(n)
	let p = 0
	for (const r of parts) {
		out.set(r, p)
		p += r.length
	}
	return out
}

function hexTo20(sha: string): Uint8Array {
	const out = new Uint8Array(20)
	for (let i = 0; i < 20; i++) {
		out[i] = Number.parseInt(sha.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}
