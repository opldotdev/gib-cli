import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { importHead } from '../src/fetch.ts'
import { mintGenesis, pushLine } from '../src/push.ts'
import { walletPublisher } from '../src/publish.ts'
import { Peer } from '../src/remote/peer.ts'
import { pullRepo } from '../src/remote/sync.ts'
import { emptyRepoState, refKey } from '../src/refs.ts'
import { commitFiles, git, removeFile, tempRepo } from './fakes/git.ts'
import { startFakePeer } from './fakes/peer.ts'
import { FakeWallet } from './fakes/wallet.ts'
import { memStore } from './helpers.ts'

const trash: string[] = []
const stoppable: Array<{ stop: () => void }> = []
afterEach(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
	for (const s of stoppable.splice(0)) s.stop()
})

async function publisher(seed: number, files: Record<string, string>) {
	const fake = await FakeWallet.create(new PrivateKey(seed))
	const wallet = fake.asWallet()
	const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
	const repo = await tempRepo(files)
	trash.push(home, repo.dir)
	const fakePeer = startFakePeer()
	stoppable.push(fakePeer)
	const peer = new Peer({
		submit: `${fakePeer.url}/1sat/gib/overlay`,
		lookup: `${fakePeer.url}/1sat/gib/overlay`,
	})
	const store = memStore()
	return {
		fake,
		fakePeer,
		peer,
		repo,
		store,
		base: {
			gitDir: repo.gitDir,
			store,
			wallet,
			publisher: walletPublisher(wallet),
			identity: fake.identityKey,
			home,
			peer,
		},
	}
}

/** Three commits: one from `gib init`, two more in a single push. */
async function publishThree() {
	const p = await publisher(4242, {
		'README.md': '# demo\n',
		'src/a.ts': 'export const a = 1\n',
	})
	const genesis = await mintGenesis({ ...p.base, rev: 'HEAD', branch: 'main' })
	const sha2 = await commitFiles(p.repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
	await removeFile(p.repo.dir, 'src/a.ts')
	const sha3 = await commitFiles(p.repo.dir, { 'docs/x.md': 'x' }, 'v3')
	const pushed = await pushLine('push HEAD:refs/heads/main', {
		...p.base,
		origin: genesis.origin,
	})
	if (!pushed.ok) throw new Error(pushed.error)
	return { ...p, genesis, pushed, shas: [genesis.sha, sha2, sha3] }
}

describe('fetch from a peer', () => {
	it('sends two heads for two pushes, and the peer holds both', async () => {
		const { fakePeer, genesis, pushed } = await publishThree()
		const heads = fakePeer.heads()
		expect(heads).toHaveLength(2)
		expect(heads.every((h) => h.origin === genesis.origin)).toBe(true)
		expect(heads[heads.length - 1].outpoint).toBe(pushed.head)
	})

	it('clones every commit from one root, and git accepts the history', async () => {
		const { fakePeer, peer, genesis, pushed, shas } = await publishThree()

		// A reader with nothing: an empty store and no wallet at all.
		const store = memStore()
		const state = emptyRepoState(genesis.origin)
		expect(await pullRepo(peer, store, state)).toBe(2)
		expect(state.genesis?.branch).toBe('main')
		const ref = state.refs[refKey(fakePeer.heads()[0].identity, 'main')]
		expect(ref.head).toBe(pushed.head)
		expect(ref.sha).toBe(shas[2])

		const clone = await mkdtemp(join(tmpdir(), 'gib-clone-'))
		trash.push(clone)
		await git(clone, ['init', '-q', '--bare'])
		const imported = await importHead(store, clone, ref.head, peer)
		expect(imported.tip).toBe(shas[2])
		expect(imported.commits).toBe(3)

		for (const sha of shas) {
			expect(await git(clone, ['cat-file', '-t', sha])).toBe('commit')
		}
		// Every commit has its tree and its blobs: git's own connectivity
		// check walks commit to tree to blob, and fsck is that check.
		await git(clone, ['rev-list', '--objects', '--quiet', shas[2]])
		await git(clone, ['fsck', '--strict', '--no-dangling'])
		expect(await git(clone, ['ls-tree', '-r', '--name-only', shas[2]])).toBe(
			'README.md\ndocs/x.md',
		)
		expect(await git(clone, ['ls-tree', '-r', '--name-only', shas[0]])).toBe(
			'README.md\nsrc/a.ts',
		)
		expect(await git(clone, ['cat-file', 'blob', `${shas[2]}:README.md`])).toBe(
			'# demo v2',
		)

		// Content came over the txs lookup, in batches.
		const txsCalls = fakePeer.calls.filter((c) => c === 'lookup:txs')
		expect(txsCalls.length).toBeGreaterThan(0)
		expect(txsCalls.length).toBeLessThan(8)
	})

	it('fetches again without re-reading what git already has', async () => {
		const p = await publishThree()
		const store = memStore()
		const state = emptyRepoState(p.genesis.origin)
		await pullRepo(p.peer, store, state)
		const clone = await mkdtemp(join(tmpdir(), 'gib-clone-'))
		trash.push(clone)
		await git(clone, ['init', '-q', '--bare'])
		const ref = Object.values(state.refs)[0]
		await importHead(store, clone, ref.head, p.peer)

		const sha4 = await commitFiles(p.repo.dir, { 'docs/y.md': 'y' }, 'v4')
		const again = await pushLine('push HEAD:refs/heads/main', {
			...p.base,
			origin: p.genesis.origin,
		})
		if (!again.ok) throw new Error(again.error)
		await pullRepo(p.peer, store, state)
		const imported = await importHead(store, clone, again.head, p.peer)
		expect(imported.tip).toBe(sha4)
		// Only the new commit and its tree: the rest is named by a sha git
		// already has.
		expect(imported.commits).toBe(1)
		expect(imported.trees).toBe(1)
		await git(clone, ['fsck', '--strict', '--no-dangling'])
	})

	it('restarts a branch when the peer does not know where we stopped', async () => {
		const { peer, genesis } = await publishThree()
		const store = memStore()
		const state = emptyRepoState(genesis.origin)
		state.cursors.main = `${'e'.repeat(64)}_0`
		expect(await pullRepo(peer, store, state)).toBe(2)
		expect(state.cursors.main).not.toBe(`${'e'.repeat(64)}_0`)
	})

	it('finds a branch the repository names in .gib but nothing else knows', async () => {
		const p = await publisher(7, {
			'.gib': '{"name":"demo","defaultBranch":"trunk"}\n',
		})
		await git(p.repo.dir, ['branch', '-m', 'trunk'])
		const genesis = await mintGenesis({ ...p.base, rev: 'HEAD', branch: 'trunk' })
		await commitFiles(p.repo.dir, { 'x.txt': 'x' }, 'second')
		const pushed = await pushLine('push HEAD:refs/heads/trunk', {
			...p.base,
			origin: genesis.origin,
		})
		expect(pushed.ok).toBe(true)

		const reader = memStore()
		const state = emptyRepoState(genesis.origin)
		expect(await pullRepo(p.peer, reader, state)).toBe(2)
		expect(state.branches).toContain('trunk')
	})
})
