import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { previousHead, readHead } from '../src/head.ts'
import { parseOutpoint } from '../src/outpoint.ts'
import { mintGenesis, pushLine } from '../src/push.ts'
import { walletPublisher } from '../src/publish.ts'
import { loadTx } from '../src/resolver.ts'
import { decodeCommitToken } from '../src/token.ts'
import { collectTree } from '../src/tree.ts'
import type { TxStore } from '../src/txstore.ts'
import { commitFiles, git, removeFile, tempRepo } from './fakes/git.ts'
import { FakeWallet } from './fakes/wallet.ts'
import { memStore } from './helpers.ts'

const trash: string[] = []
afterEach(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup() {
	const fake = await FakeWallet.create(new PrivateKey(4242))
	const wallet = fake.asWallet()
	const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
	const repo = await tempRepo({
		'README.md': '# demo\n',
		'src/a.ts': 'export const a = 1\n',
	})
	trash.push(home, repo.dir)
	const store = memStore()
	return {
		fake,
		home,
		repo,
		store,
		base: {
			gitDir: repo.gitDir,
			store,
			wallet,
			publisher: walletPublisher(wallet),
			identity: fake.identityKey,
			home,
		},
	}
}

/** The commit a head publishes, and the head it spent. */
async function headAt(store: TxStore, outpoint: string) {
	const head = await readHead(store, outpoint)
	return { ...head, prev: await previousHead(store, outpoint) }
}

describe('push: one head per commit', () => {
	it('mints a genesis, then a chain of heads spending forward', async () => {
		const { fake, repo, store, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		expect(genesis.origin).toMatch(/^[0-9a-f]{64}_\d+$/)
		expect(genesis.minted).toBe(1)

		const sha2 = await commitFiles(repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
		await removeFile(repo.dir, 'src/a.ts')
		const sha3 = await commitFiles(repo.dir, { 'docs/x.md': 'x' }, 'v3')

		const r = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
		})
		expect(r.ok).toBe(true)
		if (!r.ok) throw new Error(r.error)
		expect(r.minted).toBe(2)
		expect(r.sha).toBe(sha3)

		// The spend chain is the commit history: tip -> v2 -> genesis.
		const tip = await headAt(store, r.head)
		expect(tip.sha).toBe(sha3)
		expect(tip.token.origin).toBe(genesis.origin)
		expect(tip.token.branch).toBe('main')
		expect(tip.token.identityPubkey).toBe(fake.identityKey)
		const mid = await headAt(store, tip.prev ?? '')
		expect(mid.sha).toBe(sha2)
		const first = await headAt(store, mid.prev ?? '')
		expect(first.sha).toBe(genesis.sha)
		expect(first.prev).toBeUndefined()

		// Each head publishes its own tree, and the tree is the commit's.
		const files = await collectTree(store, parseOutpoint(tip.token.root))
		expect(files.map((f) => f.path).sort()).toEqual([
			'README.md',
			'docs/x.md',
		])
		const midFiles = await collectTree(store, parseOutpoint(mid.token.root))
		expect(midFiles.map((f) => f.path).sort()).toEqual([
			'README.md',
			'src/a.ts',
		])

		// All the new content for both commits rode in one transaction.
		const contentTxids = new Set([
			parseOutpoint(tip.token.root).txid,
			parseOutpoint(mid.token.root).txid,
		])
		expect(contentTxids.size).toBe(1)
	})

	it('refuses a non-fast-forward, and another publisher\'s branch', async () => {
		const { repo, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		await git(repo.dir, ['checkout', '-q', '--orphan', 'other'])
		await commitFiles(repo.dir, { 'z.txt': 'z' }, 'unrelated')
		const r = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
		})
		expect(r).toEqual({
			ok: false,
			dst: 'refs/heads/main',
			error: 'non-fast-forward',
		})
		const foreign = await pushLine(
			`push HEAD:refs/heads/@${'02'.repeat(33)}/main`,
			{ ...base, origin: genesis.origin },
		)
		expect(foreign.ok).toBe(false)
		if (!foreign.ok) expect(foreign.error).toContain('another publisher')
	})

	it('mints nothing when the head already publishes the commit', async () => {
		const { fake, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const before = fake.actionLog().length
		const r = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
		})
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.minted).toBe(0)
		expect(fake.actionLog()).toHaveLength(before)
	})

	it('deletes a branch by burning its head', async () => {
		const { repo, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		await git(repo.dir, ['checkout', '-q', '-b', 'feature'])
		await commitFiles(repo.dir, { 'f.txt': 'f' }, 'feature')
		const pushed = await pushLine('push HEAD:refs/heads/feature', {
			...base,
			origin: genesis.origin,
		})
		expect(pushed.ok).toBe(true)
		const deleted = await pushLine('push :refs/heads/feature', {
			...base,
			origin: genesis.origin,
		})
		expect(deleted.ok).toBe(true)
		if (deleted.ok) expect(deleted.sha).toBe('0'.repeat(40))
		const again = await pushLine('push :refs/heads/feature', {
			...base,
			origin: genesis.origin,
		})
		expect(again).toEqual({
			ok: false,
			dst: 'refs/heads/feature',
			error: 'no such ref',
		})
	})
})
