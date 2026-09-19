import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import { localPublisher } from '../src/publish-local.ts'
import { runHelper } from '../src/remote/helper.ts'
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

describe('git-remote-gib genesis push', () => {
	it('mints the origin, repoints the remote, and reports the URL', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'gib-genesis-'))
		const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
		try {
			await git(dir, ['init', '-q', '-b', 'main'])
			await git(dir, ['config', 'user.email', 't@t'])
			await git(dir, ['config', 'user.name', 't'])
			await git(dir, ['remote', 'add', 'origin', 'gib://new'])
			await writeFile(join(dir, 'README.md'), '# x\n')
			await git(dir, ['add', 'README.md'])
			await git(dir, ['commit', '-q', '-m', 'init'])

			const wallet = new ProtoWallet(new PrivateKey(4242)) as unknown as WalletInterface
			const lines = ['capabilities', 'push HEAD:refs/heads/main', '']
			let i = 0
			const out: string[] = []
			const log: string[] = []
			await runHelper({
				url: 'gib://new',
				remoteName: 'origin',
				store: memStore(),
				wallet,
				publisher: localPublisher(wallet),
				gitDir: join(dir, '.git'),
				home,
				log: (s) => log.push(s),
				io: {
					async read() {
						return i < lines.length ? lines[i++] : null
					},
					write(s) {
						out.push(s)
					},
				},
			})

			expect(out.join('')).toContain('ok refs/heads/main')
			const url = await git(dir, ['remote', 'get-url', 'origin'])
			expect(url).toMatch(/^gib:\/\/[0-9a-f]{64}_\d+$/)
			expect(log.join('')).toContain(`minted repository ${url}`)
			expect(log.join('')).toContain(`remote 'origin' now points at ${url}`)
		} finally {
			await rm(dir, { recursive: true, force: true })
			await rm(home, { recursive: true, force: true })
		}
	})
})
