import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { gibInit } from '../src/init.ts'
import { loadIdentity } from '../src/identity.ts'
import { loadRepoState } from '../src/refs.ts'
import { parseRepoMeta } from '../src/repo-meta.ts'
import { commitFiles, git, tempRepo } from './fakes/git.ts'
import { FakeWallet } from './fakes/wallet.ts'
import { memStore } from './helpers.ts'

const trash: string[] = []
afterEach(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup(files: Record<string, string> = { 'README.md': '# x\n' }) {
	const fake = await FakeWallet.create(new PrivateKey(4242))
	const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
	const repo = await tempRepo(files)
	trash.push(home, repo.dir)
	return {
		fake,
		home,
		repo,
		opts: {
			cwd: repo.dir,
			wallet: fake.asWallet(),
			store: memStore(),
			home,
		},
	}
}

describe('gib init', () => {
	it('mints the repository, writes .gib and adds the local remote', async () => {
		const { fake, home, repo, opts } = await setup()
		const r = await gibInit(opts)
		expect(r.created).toBe(true)
		expect(r.origin).toMatch(/^[0-9a-f]{64}_\d+$/)
		expect(r.branch).toBe('main')
		expect(r.sha).toBe(repo.sha)
		expect(r.identity).toBe(fake.identityKey)
		expect(r.peerUrl).toBe(`gib://gibhub.net/${r.origin}`)

		const meta = parseRepoMeta(await readFile(r.file, 'utf8'))
		expect(meta.defaultBranch).toBe('main')
		expect(meta.name).toBeTruthy()
		expect(await git(repo.dir, ['remote', 'get-url', 'local'])).toBe(
			`gib://${r.origin}`,
		)

		// The genesis head is on record, so `list` works before any peer.
		const state = await loadRepoState(r.origin, home)
		expect(state.genesis).toEqual({
			identity: fake.identityKey,
			branch: 'main',
			head: r.head,
		})
		expect(await loadIdentity(home)).toBe(fake.identityKey)
	})

	it('does not mint a second repository for a repository that has one', async () => {
		const { fake, opts } = await setup()
		const first = await gibInit(opts)
		const before = fake.actionLog().length
		const again = await gibInit(opts)
		expect(again.created).toBe(false)
		expect(again.origin).toBe(first.origin)
		expect(fake.actionLog()).toHaveLength(before)
	})

	it('publishes the branch HEAD is on', async () => {
		const { repo, opts } = await setup()
		await git(repo.dir, ['checkout', '-q', '-b', 'trunk'])
		await commitFiles(repo.dir, { 'x.txt': 'x' }, 'on trunk')
		const r = await gibInit(opts)
		expect(r.branch).toBe('trunk')
		expect(r.meta.defaultBranch).toBe('trunk')
	})

	it('refuses a directory that is not a git repository, or has no commit', async () => {
		const { opts } = await setup()
		const empty = await mkdtemp(join(tmpdir(), 'gib-empty-'))
		trash.push(empty)
		expect(gibInit({ ...opts, cwd: empty })).rejects.toThrow(
			/not a git repository/,
		)
		await git(empty, ['init', '-q'])
		expect(gibInit({ ...opts, cwd: empty })).rejects.toThrow(/at least one commit/)
	})
})
