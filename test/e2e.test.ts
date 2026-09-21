/**
 * The whole thing, driven by real git: `gib init` mints a repository from
 * three commits into one head, a peer remote publishes it, a reader with
 * no wallet clones it and git accepts the history, a second publisher
 * branches from that head without republishing a single object of it, the
 * first merges that branch back, and a branch is pushed and deleted.
 *
 * Nothing here touches a network or a real wallet: the wallet is the fake
 * BRC-100 server, the peer is the fake overlay, and both run in process.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { previousHead, readHead } from '../src/head.ts'
import { parseOutpoint } from '../src/outpoint.ts'
import { readDir } from '../src/tree.ts'
import { fileTxStore } from '../src/txstore.ts'
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

/** The `.git` object store of a head's root, by entry name. */
async function objectsOf(home: string, headOutpoint: string) {
	const store = fileTxStore(home)
	const head = await readHead(store, headOutpoint)
	const entries = await readDir(store, head.root)
	const dir = entries.find((e) => e.name === '.git')
	if (!dir) throw new Error('no .git store')
	return new Map(
		(await readDir(store, dir.outpoint)).map((o) => [
			o.name,
			`${o.outpoint.txid}_${o.outpoint.vout}`,
		]),
	)
}

describe('git end to end', () => {
	it('inits, publishes, clones, branches, merges and deletes', async () => {
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

		// Publisher 1: three commits, then one `gib init`.
		const repo = await tempRepo({
			'README.md': '# demo\n',
			'src/a.ts': 'export const a = 1\n',
			'.gib': '{"name":"demo","defaultBranch":"main"}\n',
		})
		trash.push(repo.dir)
		const sha1 = repo.sha
		const sha2 = await commitFiles(repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
		await rm(join(repo.dir, 'src/a.ts'))
		const sha3 = await commitFiles(repo.dir, { 'docs/x.md': 'x' }, 'v3')

		const init = await must(repo.dir, env1, ['gib', 'init', '-y'])
		const origin = init.match(/minted repository origin ([0-9a-f]{64}_\d+)/)?.[1]
		expect(origin).toBeTruthy()
		expect(init).toContain(`git remote add gib gib://gibhub.net/${origin}`)
		expect(peer.heads()).toHaveLength(0) // init publishes to no peer

		const url = `gib://${peer.host}/${origin}`
		await must(repo.dir, env1, ['git', 'remote', 'add', 'gib', url])
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'main'])

		// One head for three commits.
		expect(peer.heads()).toHaveLength(1)
		const head1 = peer.heads()[0].outpoint
		const identity1 = peer.heads()[0].identity
		expect(await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])).toContain(
			`${sha3}\trefs/heads/main`,
		)
		const objects1 = await objectsOf(home1, head1)
		for (const sha of [sha1, sha2, sha3]) expect(objects1.has(sha)).toBe(true)

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
		expect(await must(clone, readerEnv, ['git', 'rev-list', '--count', 'HEAD'])).toBe('3')
		expect(await Bun.file(join(clone, 'docs/x.md')).text()).toBe('x')
		expect(await Bun.file(join(clone, 'src/a.ts')).exists()).toBe(false)
		// Every commit has its tree and blobs, so git accepts the history.
		await must(clone, readerEnv, ['git', 'fsck', '--strict', '--no-dangling'])
		await must(clone, readerEnv, ['git', 'checkout', '-q', sha1])
		expect(await Bun.file(join(clone, 'src/a.ts')).exists()).toBe(true)

		// Publisher 2 clones and branches from publisher 1's head.
		const home2 = await mkdtemp(join(tmpdir(), 'gib-home2-'))
		const work2 = await mkdtemp(join(tmpdir(), 'gib-work2-'))
		trash.push(home2, work2)
		const env2 = env(home2, wallet2.url)
		await must(work2, env2, ['git', 'clone', '-q', url, 'demo'])
		const dir2 = join(work2, 'demo')
		await must(dir2, env2, ['git', 'checkout', '-q', '-b', 'feature'])
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

		await must(dir2, env2, ['git', 'push', '-q', 'origin', 'feature'])
		const head2 = peer.heads().find((h) => h.branch === 'feature')
		if (!head2) throw new Error('feature head missing')
		expect(peer.heads()).toHaveLength(2)

		// Branching copies nothing: publisher 1's commit objects are cited
		// exactly where publisher 1 published them.
		const objects2 = await objectsOf(home2, head2.outpoint)
		for (const sha of [sha1, sha2, sha3]) {
			expect(objects2.get(sha)).toBe(objects1.get(sha))
		}
		const newTxid = parseOutpoint(objects2.get(sha4) ?? '').txid
		for (const sha of [sha1, sha2, sha3]) {
			expect(parseOutpoint(objects2.get(sha) ?? '').txid).not.toBe(newTxid)
		}
		// The token's parents mirror the commit's: nothing spent, one fork.
		const forked = await readHead(fileTxStore(home2), head2.outpoint)
		expect(forked.token.branchedFrom).toBe(head1)

		// Publisher 1 commits again, then merges publisher 2's branch. No
		// lookup enumerates a repository's branches, so the branch name is
		// named once — that is what `gib sync <url> <branch>` is for.
		await must(repo.dir, env1, ['gib', 'sync', url, 'feature'])
		await commitFiles(repo.dir, { 'docs/y.md': 'y' }, 'v4')
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'main'])
		await must(repo.dir, env1, [
			'git',
			'pull',
			'-q',
			'--no-rebase',
			'--no-edit',
			'gib',
			`@${forked.token.identityPubkey}/feature`,
		])
		expect(await Bun.file(join(repo.dir, 'two.txt')).text()).toBe('from 2')
		const merge = await must(repo.dir, env1, ['git', 'rev-parse', 'HEAD'])
		expect(
			(await must(repo.dir, env1, ['git', 'rev-list', '--parents', '-n1', merge]))
				.split(' ')
				.length,
		).toBe(3)
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'main'])
		const mainHeads = peer.heads().filter((h) => h.branch === 'main')
		const mergeHead = mainHeads[mainHeads.length - 1]
		const mergeToken = await readHead(fileTxStore(home1), mergeHead.outpoint)
		// A merge head carries both: the spend is the first parent, the
		// field is the one it merged in.
		expect(mergeToken.token.branchedFrom).toBe(head2.outpoint)
		expect(
			await previousHead(fileTxStore(home1), mergeHead.outpoint),
		).toBe(mainHeads[mainHeads.length - 2].outpoint)
		expect(await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])).toContain(
			`${merge}\trefs/heads/main`,
		)

		// A reader picks the merge up and git still accepts the history.
		await must(clone, readerEnv, ['git', 'checkout', '-q', '-'])
		await must(clone, readerEnv, ['git', 'fetch', '-q', 'origin'])
		await must(clone, readerEnv, ['git', 'fsck', '--strict', '--no-dangling'])

		// A second peer, which has never heard of the repository: pushing
		// to it sends the whole chain and the content its trees cite, so a
		// reader can clone from it too.
		const mirror = startFakePeer()
		stoppable.push(mirror)
		const mirrorUrl = `gib://${mirror.host}/${origin}`
		await must(repo.dir, env1, ['git', 'remote', 'add', 'mirror', mirrorUrl])
		await must(repo.dir, env1, ['git', 'push', '-q', 'mirror', 'main'])
		expect(mirror.heads().length).toBeGreaterThanOrEqual(3)
		const work3 = await mkdtemp(join(tmpdir(), 'gib-work3-'))
		const readerHome3 = await mkdtemp(join(tmpdir(), 'gib-reader3-'))
		trash.push(work3, readerHome3)
		const readerEnv3 = env(readerHome3, 'http://127.0.0.1:1')
		await must(work3, readerEnv3, ['git', 'clone', '-q', mirrorUrl, 'demo'])
		const clone3 = join(work3, 'demo')
		expect(await must(clone3, readerEnv3, ['git', 'rev-parse', 'HEAD'])).toBe(merge)
		await must(clone3, readerEnv3, ['git', 'fsck', '--strict', '--no-dangling'])

		// A branch, then deleting it on the peer.
		await must(repo.dir, env1, ['git', 'checkout', '-q', '-b', 'scratch'])
		await commitFiles(repo.dir, { 'f.txt': 'f' }, 'scratch')
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', 'scratch'])
		expect(await must(repo.dir, env1, ['git', 'ls-remote', 'gib'])).toContain(
			'refs/heads/scratch',
		)
		await must(repo.dir, env1, ['git', 'push', '-q', 'gib', ':scratch'])
		expect(
			await must(repo.dir, env1, ['git', 'ls-remote', 'gib']),
		).not.toContain('refs/heads/scratch')
	}, 180_000)
})
