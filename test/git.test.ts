import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitHash, writeGitObject } from '../src/git.ts'

describe('git objects', () => {
	it('hashes a blob like git hash-object', () => {
		const body = new TextEncoder().encode('hello\n')
		expect(gitHash('blob', body)).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
	})

	it('writes a loose object git can see', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'gib-git-'))
		try {
			await Bun.spawn(['git', 'init', '-q', dir]).exited
			const gitDir = join(dir, '.git')
			const sha = await writeGitObject(
				gitDir,
				'blob',
				new TextEncoder().encode('hello\n'),
			)
			expect(sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
			const proc = Bun.spawn(
				['git', '--git-dir', gitDir, 'cat-file', '-p', sha],
				{ stdout: 'pipe', stderr: 'pipe' },
			)
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			])
			expect(err).toBe('')
			expect(code).toBe(0)
			expect(out).toBe('hello\n')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
