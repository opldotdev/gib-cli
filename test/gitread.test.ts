import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitHash } from '../src/git.ts'
import {
	commitBytes,
	filesAtCommit,
	parsePushLine,
	revParse,
	treeShaFromCommit,
} from '../src/gitread.ts'

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

describe('gitread', () => {
	it('reads commit bytes and files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'gib-gr-'))
		try {
			await git(dir, ['init', '-q', '-b', 'main'])
			await git(dir, ['config', 'user.email', 't@t'])
			await git(dir, ['config', 'user.name', 't'])
			await writeFile(join(dir, 'a.txt'), 'hello\n')
			await git(dir, ['add', 'a.txt'])
			await git(dir, ['commit', '-q', '-m', 'one'])
			const gitDir = join(dir, '.git')
			const sha = await revParse(gitDir, 'HEAD')
			const body = await commitBytes(gitDir, sha)
			expect(gitHash('commit', body)).toBe(sha)
			expect(treeShaFromCommit(body)).toHaveLength(40)
			const files = await filesAtCommit(gitDir, sha)
			expect(files).toHaveLength(1)
			expect(files[0].path).toBe('a.txt')
			expect(new TextDecoder().decode(files[0].bytes)).toBe('hello\n')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('parses push specs', () => {
		expect(parsePushLine('push refs/heads/main:refs/heads/main')).toEqual({
			force: false,
			src: 'refs/heads/main',
			dst: 'refs/heads/main',
			del: false,
		})
		expect(parsePushLine('push +refs/heads/main:refs/heads/main').force).toBe(true)
		expect(parsePushLine('push :refs/heads/old').del).toBe(true)
	})
})
