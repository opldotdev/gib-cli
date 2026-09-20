/**
 * The whole thing, driven by real git: `gib init` mints a repository into
 * the local store, a peer remote publishes it, a reader with no wallet
 * clones it from that peer, a second publisher pushes its own branch, the
 * first pulls it, and a branch is pushed and deleted.
 *
 * Nothing here touches a network or a real wallet: the wallet is the fake
 * BRC-100 server, the peer is the fake overlay, and both run in process.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { commitFiles, gitEnv, tempRepo } from './fakes/git.ts'
import { startFakePeer } from './fakes/peer.ts'
import { FakeWallet } from './fakes/wallet.ts'

const src = resolve(import.meta.dir, '..', 'src')
const trash: string[] = []
const stoppable: Array<{ stop: () => void }> = []
afterAll(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
	for (const s of stoppable.splice(0)) s.stop()
})

/** A directory on PATH holding `git-remote-gib` and `gib`. */
async function binDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'gib-bin-'))
	trash.push(dir)
	for (const [name, script] of [
		['git-remote-gib', 'git-remote-gib.ts'],
		['gib', 'main.ts'],
	]) {
		const path = join(dir, name)
		await writeFile(path, `#!/bin/sh\nexec bun run ${join(src, script)} "$@"\n`)
		await chmod(path, 0o755)
	}
	return dir
}

type Env = Record<string, string>

async function run(
	dir: string,
	env: Env,
	cmd: string[],
): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, {
		cwd: dir,
		env: { ...process.env, ...gitEnv(), ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { code, out: `${out}${err}` }
}

async function must(dir: string, env: Env, cmd: string[]): Promise<string> {
	const r = await run(dir, env, cmd)
	if (r.code !== 0) throw new Error(`${cmd.join(' ')} failed:\n${r.out}`)
	return r.out.trim()
}

describe('git end to end', () => {
	it('inits, publishes, clones, shares and deletes', async () => {
		const bin = await binDir()
		const peer = startFakePeer()
		stoppable.push(peer)

		const wallet1 = (await FakeWallet.create(new PrivateKey(4242))).listen()
		const wallet2 = (await FakeWallet.create(new PrivateKey(7))).listen()
		stoppable.push(wallet1, wallet2)

		const env = (home: string, walletUrl: string): Env => ({
			PATH: `${bin}:${process.env.PATH}`,
			GIB_HOME: home,
			GIB_WALLET_URL: walletUrl,
		})
		const home1 = await mkdtemp(join(tmpdir(), 'gib-home1-'))
		const env1 = env(home1, wallet1.url)
		trash.push(home1)

		// Publisher 1: gib init mints the repository locally.
		const repo = await tempRepo({
			'README.md': '# demo\n',
			'src/a.ts': 'export const a = 1\n',
			'.gib': '{"name":"demo","defaultBranch":"main"}\n',
		})
		trash.push(repo.dir)
		const init = await must(repo.dir, env1, ['gib', 'init', '-y'])
		const origin = init.match(/minted repository origin ([0-9a-f]{64}_\d+)/)?.[1]
		expect(origin).toBeTruthy()
		expect(init).toContain(`git remote add gib gib://gibhub.net/${origin}`)
		expect(peer.heads()).toHaveLength(0) // init publishes to no peer

		const url = `gib://${peer.host}/${origin}`
		await must(repo.dir, env1, ['git', 'remote', 'add', 'gib', url])

		// Two more commits, then one push: three heads, one per commit.
		await commitFiles(repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
		await rm(join(repo.dir, 'src/a.ts'))
		const sha3 = await commitFiles(repo.dir, { 'docs/x.md': 'x' }, 'v3')
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'main'])
		expect(peer.heads()).toHaveLength(3)

		const identity1 = peer.heads()[0].identity
		const lsRemote = await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])
		expect(lsRemote).toContain(`${sha3}\trefs/heads/main`)

		// A reader: no wallet at all, a fresh store, clones from the peer.
		const readerHome = await mkdtemp(join(tmpdir(), 'gib-reader-'))
		const work = await mkdtemp(join(tmpdir(), 'gib-work-'))
		trash.push(readerHome, work)
		const readerEnv = env(readerHome, 'http://127.0.0.1:1')
		await must(work, readerEnv, ['git', 'clone', '-q', url, 'demo'])
		const clone = join(work, 'demo')
		const readerRefs = await must(clone, readerEnv, ['git', 'ls-remote', 'origin'])
		expect(readerRefs).toContain(`${sha3}\trefs/heads/@${identity1}/main`)
		expect(readerRefs).not.toContain('\trefs/heads/main')
		expect(await must(clone, readerEnv, ['git', 'symbolic-ref', 'HEAD'])).toBe(
			`refs/heads/@${identity1}/main`,
		)
		expect(await must(clone, readerEnv, ['git', 'rev-parse', 'HEAD'])).toBe(sha3)
		expect(await Bun.file(join(clone, 'docs/x.md')).text()).toBe('x')
		expect(await Bun.file(join(clone, 'src/a.ts')).exists()).toBe(false)
		await must(clone, readerEnv, ['git', 'fsck', '--strict', '--no-dangling'])
		// The whole history came across, one commit per head.
		expect(
			(await must(clone, readerEnv, ['git', 'rev-list', '--count', 'HEAD'])),
		).toBe('3')

		// Publisher 2 clones, commits and publishes its own main.
		const home2 = await mkdtemp(join(tmpdir(), 'gib-home2-'))
		const work2 = await mkdtemp(join(tmpdir(), 'gib-work2-'))
		trash.push(home2, work2)
		const env2 = env(home2, wallet2.url)
		await must(work2, env2, ['git', 'clone', '-q', url, 'demo'])
		const dir2 = join(work2, 'demo')
		await must(dir2, env2, ['git', 'checkout', '-q', '-B', 'main'])
		const sha4 = await commitFiles(dir2, { 'two.txt': 'from 2' }, 'two')

		// Another publisher's branch cannot be pushed.
		const foreign = await run(dir2, env2, [
			'git',
			'push',
			'origin',
			`HEAD:refs/heads/@${identity1}/main`,
		])
		expect(foreign.code).not.toBe(0)
		expect(foreign.out).toContain('another publisher')

		await must(dir2, env2, ['git', 'push', '-q', 'origin', 'HEAD:refs/heads/main'])
		const refs2 = await must(dir2, env2, ['git', 'ls-remote', 'origin'])
		expect(refs2).toContain(`${sha4}\trefs/heads/main`)
		expect(refs2).toContain(`${sha3}\trefs/heads/@${identity1}/main`)

		// Publisher 1 pulls publisher 2's branch and republishes the merge.
		const identity2 = peer
			.heads()
			.map((h) => h.identity)
			.find((id) => id !== identity1)
		expect(identity2).toBeTruthy()
		await must(repo.dir, env1, [
			'git',
			'pull',
			'-q',
			'--no-rebase',
			'gib',
			`@${identity2}/main`,
		])
		expect(await Bun.file(join(repo.dir, 'two.txt')).text()).toBe('from 2')
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'main'])
		const merged = await must(repo.dir, env1, ['git', 'rev-parse', 'HEAD'])
		expect(await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])).toContain(
			`${merged}\trefs/heads/main`,
		)

		// A branch, then deleting it on the peer.
		await must(repo.dir, env1, ['git', 'checkout', '-q', '-b', 'feature'])
		await commitFiles(repo.dir, { 'f.txt': 'f' }, 'feature')
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'feature'])
		expect(await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])).toContain(
			'refs/heads/feature',
		)
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', ':feature'])
		expect(
			await must(repo.dir, env1, ['git', 'ls-remote', 'gib']),
		).not.toContain('refs/heads/feature')
	}, 120_000)
})
