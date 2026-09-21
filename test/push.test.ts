import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { importRoot } from '../src/fetch.ts'
import { gitHash } from '../src/git.ts'
import { previousHead, readHead, tipCommit, tipSha } from '../src/head.ts'
import { parseOutpoint } from '../src/outpoint.ts'
import { mintGenesis, pushLine } from '../src/push.ts'
import { walletPublisher } from '../src/publish.ts'
import { collectSnapshot, readDir, stripGitDir, writeTree } from '../src/tree.ts'
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

/** The `.git` store of a published root, by entry name. */
async function gitStore(store: TxStore, root: string) {
	const entries = await readDir(store, parseOutpoint(root))
	const dir = entries.find((e) => e.name === '.git')
	if (!dir) throw new Error('no .git store')
	const objects = await readDir(store, dir.outpoint)
	return new Map(objects.map((o) => [o.name, o]))
}

describe('push: one head per push', () => {
	it('mints one head for three commits, carrying them all', async () => {
		const { fake, repo, store, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		expect(genesis.origin).toMatch(/^[0-9a-f]{64}_\d+$/)

		const sha2 = await commitFiles(repo.dir, { 'README.md': '# demo v2\n' }, 'v2')
		await removeFile(repo.dir, 'src/a.ts')
		const sha3 = await commitFiles(repo.dir, { 'docs/x.md': 'x' }, 'v3')

		const before = fake.actionLog().length
		const r = await pushLine('push HEAD:refs/heads/main', {
			...base,
			origin: genesis.origin,
		})
		expect(r.ok).toBe(true)
		if (!r.ok) throw new Error(r.error)
		expect(r.sha).toBe(sha3)
		expect(r.minted).toBe(true)
		expect(r.branchedFrom).toBe('')
		// One content transaction and one head, however many commits.
		expect(fake.actionLog().length - before).toBe(2)

		const head = await readHead(store, r.head)
		expect(head.token.branch).toBe('main')
		expect(head.token.identityPubkey).toBe(fake.identityKey)
		expect(head.token.branchedFrom).toBe('')
		expect(await tipSha(store, head.root)).toBe(sha3)
		// It spends the head gib init minted, and only that.
		expect(await previousHead(store, r.head)).toBe(genesis.head)

		// The store carries every commit, and every commit's tree.
		const objects = await gitStore(store, head.token.root)
		for (const sha of [genesis.sha, sha2, sha3]) {
			expect(objects.get(sha)?.isDir).toBe(false)
		}
		const trees = [...objects.values()].filter((o) => o.isDir)
		expect(trees).toHaveLength(3)
		expect(objects.get('.')?.outpoint).toEqual(objects.get(sha3)?.outpoint)
	})

	it('publishes a tree git accepts, with .git stripped', async () => {
		const { repo, store, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const clone = await mkdtemp(join(tmpdir(), 'gib-clone-'))
		trash.push(clone)
		await git(clone, ['init', '-q', '--bare'])
		const head = await readHead(store, genesis.head)
		const imported = await importRoot(store, clone, head.root)
		expect(imported.tip).toBe(genesis.sha)
		// The commit sha git produced is reproduced from the published tree.
		expect(await git(clone, ['rev-parse', `${genesis.sha}^{tree}`])).toBe(
			await git(repo.dir, ['rev-parse', 'HEAD^{tree}']),
		)
		expect(await git(clone, ['ls-tree', '--name-only', genesis.sha])).toBe(
			'README.md\nsrc',
		)
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
		if (r.ok) expect(r.minted).toBe(false)
		expect(fake.actionLog()).toHaveLength(before)
	})

	it('branches from a head it knows, citing its objects', async () => {
		const { repo, store, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const known = [
			{
				outpoint: genesis.head,
				sha: genesis.sha,
				identity: base.identity,
				branch: 'main',
			},
		]
		await git(repo.dir, ['checkout', '-q', '-b', 'feature'])
		const sha2 = await commitFiles(repo.dir, { 'f.txt': 'f' }, 'feature')
		const r = await pushLine('push HEAD:refs/heads/feature', {
			...base,
			origin: genesis.origin,
			knownHeads: known,
		})
		expect(r.ok).toBe(true)
		if (!r.ok) throw new Error(r.error)
		expect(r.branchedFrom).toBe(genesis.head)
		const head = await readHead(store, r.head)
		expect(head.token.branchedFrom).toBe(genesis.head)
		// A branch's first head spends nothing: the fork is the field.
		expect(await previousHead(store, r.head)).toBeUndefined()

		// The commit it forked from is cited where it already lives.
		const genesisHead = await readHead(store, genesis.head)
		const before = await gitStore(store, genesisHead.token.root)
		const after = await gitStore(store, head.token.root)
		expect(after.get(genesis.sha)?.outpoint).toEqual(
			before.get(genesis.sha)?.outpoint,
		)
		expect(after.get(sha2)?.outpoint).not.toEqual(
			before.get(genesis.sha)?.outpoint,
		)
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

	it('refuses to start a second chain when the wallet lost the head', async () => {
		const { base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const blind = {
			...base,
			wallet: {
				...base.wallet,
				listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
			} as typeof base.wallet,
		}
		const r = await pushLine('push HEAD:refs/heads/main', {
			...blind,
			origin: genesis.origin,
			knownHeads: [
				{
					outpoint: genesis.head,
					sha: genesis.sha,
					identity: base.identity,
					branch: 'main',
				},
			],
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.error).toContain('would start a second chain')
	})

	it('round-trips the published root to the commit sha git produced', async () => {
		const { repo, store, base } = await setup()
		const genesis = await mintGenesis({ ...base, rev: 'HEAD', branch: 'main' })
		const head = await readHead(store, genesis.head)
		const all = await collectSnapshot(store, head.root)

		// The root is git's tree plus exactly one entry.
		expect(all.files.some((f) => f.path.startsWith('.git/'))).toBe(true)
		const files = stripGitDir(all.files)
		expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'src/a.ts'])

		// Stripped, it hashes to the tree git hashed — and the commit
		// object in `.git` to the commit git made.
		const scratch = await mkdtemp(join(tmpdir(), 'gib-strip-'))
		trash.push(scratch)
		await git(scratch, ['init', '-q', '--bare'])
		expect(await writeTree(scratch, files)).toBe(
			await git(repo.dir, ['rev-parse', 'HEAD^{tree}']),
		)
		expect(gitHash('commit', await tipCommit(store, head.root))).toBe(
			await git(repo.dir, ['rev-parse', 'HEAD']),
		)
	})
})
