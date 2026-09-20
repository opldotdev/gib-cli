import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { type ChainCommit, publishChain } from '../src/chain.ts'
import { commitBytes, filesAtCommit, revList } from '../src/gitread.ts'
import { walletPublisher } from '../src/publish.ts'
import { collectTree } from '../src/tree.ts'
import { PATCH_CONTENT_TYPE } from '../src/ordfs/patch.ts'
import { commitFiles, tempRepo } from './fakes/git.ts'
import { FakeWallet } from './fakes/wallet.ts'
import { memStore } from './helpers.ts'

const trash: string[] = []
afterEach(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('publishing a chain of commits', () => {
	it('splits into more transactions when one will not hold the chain', async () => {
		const repo = await tempRepo({ 'a.txt': 'a1', 'dir/b.txt': 'b1' })
		trash.push(repo.dir)
		await commitFiles(repo.dir, { 'a.txt': 'a2' }, 'two')
		await commitFiles(repo.dir, { 'dir/c.txt': 'c1' }, 'three')
		const tip = await commitFiles(repo.dir, { 'dir/b.txt': 'b2' }, 'four')

		const fake = await FakeWallet.create(new PrivateKey(4242))
		const wallet = fake.asWallet()
		const store = memStore()
		const scratch = await mkdtemp(join(tmpdir(), 'gib-scratch-'))
		trash.push(scratch)

		const commits: ChainCommit[] = []
		for (const sha of await revList(repo.gitDir, tip)) {
			commits.push({
				sha,
				commit: await commitBytes(repo.gitDir, sha),
				files: await filesAtCommit(repo.gitDir, sha),
			})
		}
		expect(commits).toHaveLength(4)

		// A small ceiling forces the chain across several transactions.
		const published = await publishChain({
			commits,
			store,
			publisher: walletPublisher(wallet),
			labels: ['gib push'],
			scratchGitDir: scratch,
			maxOutputs: 5,
		})
		expect(published.txs.length).toBeGreaterThan(1)
		expect(published.roots.size).toBe(4)

		// Every commit's tree still resolves, across transactions.
		for (const c of commits) {
			const root = published.roots.get(c.sha)
			if (!root) throw new Error(`no root for ${c.sha}`)
			const files = await collectTree(store, root)
			expect(files.length).toBeGreaterThan(0)
		}
		const tipFiles = await collectTree(store, published.roots.get(tip) ?? { txid: '', vout: 0 })
		expect(tipFiles.map((f) => f.path).sort()).toEqual([
			'a.txt',
			'dir/b.txt',
			'dir/c.txt',
		])
		expect(new TextDecoder().decode(tipFiles[1].bytes)).toBe('b2')
	})

	it('refuses a commit that will not fit in one transaction', async () => {
		const repo = await tempRepo({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
		trash.push(repo.dir)
		const fake = await FakeWallet.create(new PrivateKey(4242))
		const scratch = await mkdtemp(join(tmpdir(), 'gib-scratch-'))
		trash.push(scratch)
		const sha = repo.sha
		expect(
			publishChain({
				commits: [
					{
						sha,
						commit: await commitBytes(repo.gitDir, sha),
						files: await filesAtCommit(repo.gitDir, sha),
					},
				],
				store: memStore(),
				publisher: walletPublisher(fake.asWallet()),
				labels: ['gib push'],
				scratchGitDir: scratch,
				maxOutputs: 2,
			}),
		).rejects.toThrow(/one content transaction holds at most 2/)
	})

	it('patches against content a closed transaction already holds', async () => {
		const repo = await tempRepo({ 'a.txt': 'one two three four five' })
		trash.push(repo.dir)
		const tip = await commitFiles(
			repo.dir,
			{ 'a.txt': 'one two three four six' },
			'edit',
		)
		const fake = await FakeWallet.create(new PrivateKey(4242))
		const store = memStore()
		const scratch = await mkdtemp(join(tmpdir(), 'gib-scratch-'))
		trash.push(scratch)
		const commits: ChainCommit[] = []
		for (const sha of await revList(repo.gitDir, tip)) {
			commits.push({
				sha,
				commit: await commitBytes(repo.gitDir, sha),
				files: await filesAtCommit(repo.gitDir, sha),
			})
		}
		// One commit per transaction: the second can patch the first.
		const published = await publishChain({
			commits,
			store,
			publisher: walletPublisher(fake.asWallet()),
			labels: ['gib push'],
			scratchGitDir: scratch,
			maxOutputs: 2,
		})
		expect(published.txs).toHaveLength(2)
		const second = published.txs[1]
		const { Transaction } = await import('@bsv/sdk')
		const tx = Transaction.fromBinary(Array.from(second.bytes))
		const { payloadFromScript } = await import('../src/content.ts')
		const types = tx.outputs
			.map((o) => payloadFromScript(o.lockingScript)?.contentType)
			.filter(Boolean)
		expect(types).toContain(PATCH_CONTENT_TYPE)
	})
})
