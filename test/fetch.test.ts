import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { importHistory } from '../src/fetch.ts'
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

/** A repository of three commits, published to a fresh fake peer. */
async function publishThree() {
	const fake = await FakeWallet.create(new PrivateKey(4242))
	const wallet = fake.asWallet()
	const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
	const repo = await tempRepo({
		'README.md': '# demo\n',
		'src/a.ts': 'export const a = 1\n',
	})
	trash.push(home, repo.dir)
	const fakePeer = startFakePeer()
	stoppable.push(fakePeer)
	const peer = new Peer({
		submit: `${fakePeer.url}/1sat/gib/overlay`,
		lookup: `${fakePeer.url}/1sat/gib/overlay`,
	})
	const store = memStore()
	const base = {
		gitDir: repo.gitDir,
		store,
		wallet,
		publisher: walletPublisher(wallet),
		identity: fake.identityKey,
		home,
		peer,
	}
	const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
	const sha2 = await commitFiles(repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
	await removeFile(repo.dir, 'src/a.ts')
	const sha3 = await commitFiles(repo.dir, { 'docs/x.md': 'x' }, 'v3')
	const pushed = await pushLine('push HEAD:refs/heads/main', {
		...base,
		origin: genesis.origin,
	})
	if (!pushed.ok) throw new Error(pushed.error)
	return {
		fake,
		fakePeer,
		peer,
		repo,
		genesis,
		pushed,
		shas: [genesis.sha, sha2, sha3],
	}
}

describe('fetch from a peer', () => {
	it('pushes the whole chain, including the head gib init minted', async () => {
		const { fakePeer, genesis, pushed } = await publishThree()
		const heads = fakePeer.heads()
		expect(heads).toHaveLength(3)
		expect(heads.every((h) => h.origin === genesis.origin)).toBe(true)
		expect(heads[0].root).toBe(genesis.origin)
		expect(heads[heads.length - 1].outpoint).toBe(pushed.head)
	})

	it('pulls a branch with headsSince and walks the trees over txs', async () => {
		const { fakePeer, peer, genesis, pushed, shas } = await publishThree()

		// A reader with nothing: an empty store and no wallet at all.
		const store = memStore()
		const state = emptyRepoState(genesis.origin)
		const added = await pullRepo(peer, store, state)
		expect(added).toBe(3)
		expect(state.genesis?.branch).toBe('main')
		const ref = state.refs[refKey(fakePeer.heads()[0].identity, 'main')]
		expect(ref.head).toBe(pushed.head)
		expect(ref.sha).toBe(shas[2])

		// Pulling again asks from the cursor and finds nothing new.
		expect(await pullRepo(peer, store, state)).toBe(0)

		const clone = await mkdtemp(join(tmpdir(), 'gib-clone-'))
		trash.push(clone)
		await git(clone, ['init', '-q', '--bare'])
		const imported = await importHistory(store, clone, ref.head, { peer })
		expect(imported.map((i) => i.commit)).toEqual([shas[2], shas[1], shas[0]])

		// The fetched trees are git's: the commits verify and the content is right.
		for (const sha of shas) {
			expect(await git(clone, ['cat-file', '-t', sha])).toBe('commit')
		}
		expect(await git(clone, ['ls-tree', '-r', '--name-only', shas[2]])).toBe(
			'README.md\ndocs/x.md',
		)
		expect(await git(clone, ['ls-tree', '-r', '--name-only', shas[0]])).toBe(
			'README.md\nsrc/a.ts',
		)
		expect(
			await git(clone, ['cat-file', 'blob', `${shas[2]}:README.md`]),
		).toBe('# demo v2')
		await git(clone, ['fsck', '--strict', '--no-dangling'])

		// Content came over the txs lookup, in batches, not one file at a time.
		const txsCalls = fakePeer.calls.filter((c) => c === 'lookup:txs')
		expect(txsCalls.length).toBeGreaterThan(0)
		expect(txsCalls.length).toBeLessThan(6)
	})

	it('restarts a branch when the peer does not know where we stopped', async () => {
		const { peer, genesis } = await publishThree()
		const store = memStore()
		const state = emptyRepoState(genesis.origin)
		state.cursors.main = `${'e'.repeat(64)}_0`
		expect(await pullRepo(peer, store, state)).toBe(3)
		expect(state.cursors.main).not.toBe(`${'e'.repeat(64)}_0`)
	})

	it('finds a branch the repository names in .gib but nothing else knows', async () => {
		const fake = await FakeWallet.create(new PrivateKey(7))
		const wallet = fake.asWallet()
		const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
		const repo = await tempRepo(
			{ '.gib': '{"name":"demo","defaultBranch":"trunk"}\n' },
			'trunk',
		)
		trash.push(home, repo.dir)
		const fakePeer = startFakePeer()
		stoppable.push(fakePeer)
		const peer = new Peer({
			submit: `${fakePeer.url}/1sat/gib/overlay`,
			lookup: `${fakePeer.url}/1sat/gib/overlay`,
		})
		const store = memStore()
		const base = {
			gitDir: repo.gitDir,
			store,
			wallet,
			publisher: walletPublisher(wallet),
			identity: fake.identityKey,
			home,
			peer,
		}
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'trunk' })
		await commitFiles(repo.dir, { 'x.txt': 'x' }, 'second')
		const pushed = await pushLine('push HEAD:refs/heads/trunk', {
			...base,
			origin: genesis.origin,
		})
		expect(pushed.ok).toBe(true)

		const reader = memStore()
		const state = emptyRepoState(genesis.origin)
		expect(await pullRepo(peer, reader, state)).toBe(2)
		expect(state.branches).toContain('trunk')
	})

	it('imports every parent of a merge, not just the tip\'s', async () => {
		const fake = await FakeWallet.create(new PrivateKey(11))
		const wallet = fake.asWallet()
		const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
		const repo = await tempRepo({ 'a.txt': 'a1' })
		trash.push(home, repo.dir)
		const fakePeer = startFakePeer()
		stoppable.push(fakePeer)
		const peer = new Peer({
			submit: `${fakePeer.url}/1sat/gib/overlay`,
			lookup: `${fakePeer.url}/1sat/gib/overlay`,
		})
		const store = memStore()
		const base = {
			gitDir: repo.gitDir,
			store,
			wallet,
			publisher: walletPublisher(wallet),
			identity: fake.identityKey,
			home,
			peer,
		}
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const c2 = await commitFiles(repo.dir, { 'a.txt': 'a2' }, 'c2')
		const first = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
		})
		if (!first.ok) throw new Error(first.error)

		// A reader takes the branch as it stands: two commits.
		const reader = memStore()
		const state = emptyRepoState(genesis.origin)
		await pullRepo(peer, reader, state)
		const clone = await mkdtemp(join(tmpdir(), 'gib-clone-'))
		trash.push(clone)
		await git(clone, ['init', '-q', '--bare'])
		await importHistory(reader, clone, first.head, { peer })

		// Now a real merge: a side branch off c2, a commit on main, merge.
		await git(repo.dir, ['checkout', '-q', '-b', 'side'])
		const side = await commitFiles(repo.dir, { 'side.txt': 's' }, 'side')
		await git(repo.dir, ['checkout', '-q', 'main'])
		const c3 = await commitFiles(repo.dir, { 'a.txt': 'a3' }, 'c3')
		await git(repo.dir, ['merge', '-q', '--no-ff', '-m', 'merge', 'side'])
		const merge = await git(repo.dir, ['rev-parse', 'HEAD'])
		const second = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
			have: [c2],
		})
		if (!second.ok) throw new Error(second.error)
		expect(second.minted).toBe(3) // c3, side, merge

		// The incremental fetch must not stop at the merge's first
		// satisfied parent and leave the other one missing.
		await pullRepo(peer, reader, state)
		const imported = await importHistory(reader, clone, second.head, { peer })
		expect(imported.map((i) => i.commit).sort()).toEqual(
			[merge, side, c3].sort(),
		)
		await git(clone, ['fsck', '--strict', '--no-dangling'])
		expect(await git(clone, ['rev-list', '--count', merge])).toBe('5')
		expect(genesis.sha).toBeTruthy()
	})
})
