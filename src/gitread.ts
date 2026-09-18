import type { IncomingFile } from './cascade.ts'

async function git(gitDir: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(['git', `--git-dir=${gitDir}`, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { code, out, err }
}

async function gitBytes(gitDir: string, args: string[]): Promise<{ code: number; out: Uint8Array; err: string }> {
	const proc = Bun.spawn(['git', `--git-dir=${gitDir}`, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { code, out: new Uint8Array(out), err }
}

export async function revParse(gitDir: string, rev: string): Promise<string> {
	const r = await git(gitDir, ['rev-parse', '--verify', rev])
	if (r.code !== 0) throw new Error(`git rev-parse ${rev}: ${r.err.trim()}`)
	return r.out.trim()
}

export async function isAncestor(gitDir: string, anc: string, desc: string): Promise<boolean> {
	const r = await git(gitDir, ['merge-base', '--is-ancestor', anc, desc])
	return r.code === 0
}

export async function commitBytes(gitDir: string, sha: string): Promise<Uint8Array> {
	const r = await gitBytes(gitDir, ['cat-file', 'commit', sha])
	if (r.code !== 0) throw new Error(`git cat-file commit ${sha}: ${r.err.trim()}`)
	return r.out
}

export function treeShaFromCommit(commit: Uint8Array): string {
	const text = new TextDecoder().decode(commit)
	const m = text.match(/^tree ([0-9a-f]{40})/m)
	if (!m) throw new Error('commit missing tree')
	return m[1]
}

export async function filesAtCommit(gitDir: string, sha: string): Promise<IncomingFile[]> {
	const r = await git(gitDir, ['ls-tree', '-r', '-z', sha])
	if (r.code !== 0) throw new Error(`git ls-tree ${sha}: ${r.err.trim()}`)
	const files: IncomingFile[] = []
	for (const rec of r.out.split('\0')) {
		if (!rec) continue
		const tab = rec.indexOf('\t')
		if (tab < 0) continue
		const meta = rec.slice(0, tab)
		const path = rec.slice(tab + 1)
		const [mode, type, blob] = meta.split(' ')
		if (type !== 'blob') continue
		const blobR = await gitBytes(gitDir, ['cat-file', 'blob', blob])
		if (blobR.code !== 0) throw new Error(`git cat-file blob ${blob}: ${blobR.err.trim()}`)
		files.push({
			path,
			bytes: blobR.out,
			exec: mode === '100755',
			symlink: mode === '120000',
			contentType: guessType(path),
		})
	}
	return files
}

function guessType(path: string): string {
	if (path.endsWith('.md')) return 'text/markdown'
	if (path.endsWith('.html')) return 'text/html'
	if (path.endsWith('.json')) return 'application/json'
	if (path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.txt')) {
		return 'text/plain'
	}
	return 'application/octet-stream'
}

export function parsePushLine(line: string): {
	force: boolean
	src: string
	dst: string
	del: boolean
} {
	let s = line.replace(/^push\s+/, '')
	const force = s.startsWith('+')
	if (force) s = s.slice(1)
	const i = s.lastIndexOf(':')
	if (i < 0) throw new Error(`bad push spec: ${line}`)
	const src = s.slice(0, i)
	const dst = s.slice(i + 1)
	return { force, src, dst, del: src === '' }
}
