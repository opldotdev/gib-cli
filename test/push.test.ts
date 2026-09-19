import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import { localPublisher } from '../src/publish-local.ts'
import { pushLine } from '../src/push.ts'
import { memStore } from './helpers.ts'

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

describe('pushLine genesis', () => {
	it('publishes content, validates, seals head', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'gib-push-'))
		const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
		try {
			await git(dir, ['init', '-q', '-b', 'main'])
			await git(dir, ['config', 'user.email', 't@t'])
			await git(dir, ['config', 'user.name', 't'])
			await writeFile(join(dir, 'README.md'), '# x\n')
			await git(dir, ['add', 'README.md'])
			await git(dir, ['commit', '-q', '-m', 'init'])
			const wallet = new ProtoWallet(new PrivateKey(4242)) as unknown as WalletInterface
			const store = memStore()
			const r = await pushLine({
				line: 'push HEAD:refs/heads/main',
				gitDir: join(dir, '.git'),
				store,
				wallet,
				publisher: localPublisher(wallet),
				origin: 'new',
				home,
			})
			expect(r.ok).toBe(true)
			if (r.ok) {
				expect(r.origin).toMatch(/_[0-9]+$/)
				expect(r.sha).toHaveLength(40)
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
			await rm(home, { recursive: true, force: true })
		}
	})
})
