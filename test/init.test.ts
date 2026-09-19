import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gibInit } from '../src/init.ts'
import { formatRepoMeta, parseRepoMeta } from '../src/repo-meta.ts'

async function git(cwd: string, args: string[]) {
	const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (code !== 0) throw new Error(err || out)
	return out.trim()
}

async function repo(branch = 'main') {
	const dir = await mkdtemp(join(tmpdir(), 'gib-init-'))
	await git(dir, ['init', '-q', '-b', branch])
	return dir
}

describe('gib init', () => {
	it('defaults name to the directory and branch to the current one', async () => {
		const dir = await repo('trunk')
		try {
			const r = await gibInit({ cwd: dir })
			expect(r.meta).toEqual({ name: basename(dir), defaultBranch: 'trunk', description: undefined })
			expect(parseRepoMeta(await readFile(join(dir, '.gib'), 'utf8'))).toEqual({
				name: basename(dir),
				defaultBranch: 'trunk',
			})
			expect(r.remoteAction).toBe('added')
			expect(await git(dir, ['remote', 'get-url', 'origin'])).toBe('gib://new')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('takes explicit values and prompt answers, keeps an existing gib remote', async () => {
		const dir = await repo()
		try {
			await git(dir, ['remote', 'add', 'origin', 'gib://abc_0'])
			const r = await gibInit({
				cwd: dir,
				description: 'from flag',
				prompt: async (d) => ({ ...d, name: 'chosen', defaultBranch: 'dev' }),
			})
			expect(r.meta).toEqual({ name: 'chosen', description: 'from flag', defaultBranch: 'dev' })
			expect(r.remoteAction).toBe('unchanged')
			expect(r.remoteUrl).toBe('gib://abc_0')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('refuses to overwrite .gib without --force and to hijack a non-gib remote', async () => {
		const dir = await repo()
		try {
			await writeFile(join(dir, '.gib'), formatRepoMeta({ name: 'keep' }))
			await expect(gibInit({ cwd: dir })).rejects.toThrow(/already exists/)
			const r = await gibInit({ cwd: dir, force: true })
			expect(r.meta.name).toBe('keep')
			await git(dir, ['remote', 'set-url', 'origin', 'https://example.com/x.git'])
			await expect(gibInit({ cwd: dir, force: true })).rejects.toThrow(/already points at/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('runs git init when the directory is not a repository', async () => {
		const plain = await mkdtemp(join(tmpdir(), 'gib-plain-'))
		try {
			const r = await gibInit({ cwd: plain, defaultBranch: 'trunk' })
			expect(r.gitInitialized).toBe(true)
			expect(r.meta.defaultBranch).toBe('trunk')
			expect(await git(plain, ['symbolic-ref', '--short', 'HEAD'])).toBe('trunk')
			expect(await git(plain, ['remote', 'get-url', 'origin'])).toBe('gib://new')
		} finally {
			await rm(plain, { recursive: true, force: true })
		}
	})

	it('rejects a bad default branch', async () => {
		const dir = await repo()
		try {
			await expect(gibInit({ cwd: dir, defaultBranch: 'bad name' })).rejects.toThrow(/branch/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
