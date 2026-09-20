import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { saveIdentity } from '../src/identity.ts'
import { mintGenesis } from '../src/push.ts'
import { walletPublisher } from '../src/publish.ts'
import { runHelper } from '../src/remote/helper.ts'
import { Peer } from '../src/remote/peer.ts'
import { emptyRepoState, recordHead, saveRepoState } from '../src/refs.ts'
import { readHead } from '../src/head.ts'
import { commitFiles, tempRepo } from './fakes/git.ts'
import { startFakePeer } from './fakes/peer.ts'
import { FakeWallet } from './fakes/wallet.ts'
import { memStore } from './helpers.ts'

const trash: string[] = []
const stoppable: Array<{ stop: () => void }> = []
afterEach(async () => {
	for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true })
	for (const s of stoppable.splice(0)) s.stop()
})

/** Run one helper conversation and collect what it wrote. */
async function converse(
	lines: string[],
	opts: Omit<Parameters<typeof runHelper>[0], 'io'>,
): Promise<string> {
	const out: string[] = []
	let i = 0
	await runHelper({
		...opts,
		io: {
			async read() {
				return i < lines.length ? lines[i++] : null
			},
			write(s) {
				out.push(s)
			},
		},
	})
	return out.join('')
}

async function initialised() {
	const fake = await FakeWallet.create(new PrivateKey(4242))
	const wallet = fake.asWallet()
	const home = await mkdtemp(join(tmpdir(), 'gib-home-'))
	const repo = await tempRepo({ 'README.md': '# demo\n' })
	trash.push(home, repo.dir)
	const store = memStore()
	const minted = await mintGenesis({
		gitDir: repo.gitDir,
		store,
		wallet,
		publisher: walletPublisher(wallet),
		identity: fake.identityKey,
		home,
		rev: 'HEAD',
		branch: 'main',
	})
	const state = emptyRepoState(minted.origin)
	const head = await readHead(store, minted.head)
	recordHead(state, {
		identity: fake.identityKey,
		branch: 'main',
		head: minted.head,
		sha: minted.sha,
		root: head.token.root,
	})
	await saveRepoState(state, home)
	await saveIdentity(fake.identityKey, home)
	const fakePeer = startFakePeer()
	stoppable.push(fakePeer)
	const peer = new Peer({
		submit: `${fakePeer.url}/1sat/gib/overlay`,
		lookup: `${fakePeer.url}/1sat/gib/overlay`,
	})
	return {
		fake,
		wallet,
		home,
		repo,
		store,
		minted,
		peer,
		fakePeer,
		base: {
			url: `gib://${fakePeer.host}/${minted.origin}`,
			store,
			peer,
			wallet: async () => wallet,
			gitDir: repo.gitDir,
			home,
			log: () => {},
		},
	}
}

describe('remote helper', () => {
	it('advertises capabilities', async () => {
		const { base } = await initialised()
		expect(await converse(['capabilities'], base)).toBe('fetch\npush\n\n')
	})

	it('lists what the store holds, bare for this wallet', async () => {
		const { base, fake, minted } = await initialised()
		const out = await converse(['list'], base)
		expect(out).toContain(`${minted.sha} refs/heads/main\n`)
		expect(out).toContain('@refs/heads/main HEAD\n')
		expect(out).not.toContain(fake.identityKey)
	})

	it('lists for a push what the peer has, not what we minted locally', async () => {
		const { base, minted, fakePeer } = await initialised()
		// The peer has never heard of this repository, so a push must be
		// told the remote has nothing — otherwise git sends nothing.
		expect(await converse(['list for-push'], base)).toBe('\n')
		expect(fakePeer.heads()).toHaveLength(0)

		// Pushing sends the chain, and then the peer does have it.
		const push = await converse(['push refs/heads/main:refs/heads/main'], base)
		expect(push).toBe('ok refs/heads/main\n\n')
		expect(fakePeer.heads()).toHaveLength(1)
		expect(await converse(['list for-push'], base)).toContain(
			`${minted.sha} refs/heads/main`,
		)
	})

	it('refuses to push another publisher\'s branch', async () => {
		const { base } = await initialised()
		const out = await converse(
			[`push refs/heads/main:refs/heads/@${'02'.repeat(33)}/main`],
			base,
		)
		expect(out).toContain('error refs/heads/')
		expect(out).toContain('another publisher')
	})

	it('reports a push error per ref when there is no wallet', async () => {
		const { base } = await initialised()
		const out = await converse(['push refs/heads/main:refs/heads/main'], {
			...base,
			wallet: undefined,
		})
		expect(out).toBe('error refs/heads/main no wallet configured\n\n')
	})

	it('fetches a ref into git from the peer', async () => {
		const { base, repo, peer, fake } = await initialised()
		const sha2 = await commitFiles(repo.dir, { 'x.txt': 'x' }, 'second')
		await converse(['push refs/heads/main:refs/heads/main'], base)

		// A reader with an empty store and no wallet.
		const readerHome = await mkdtemp(join(tmpdir(), 'gib-reader-'))
		const clone = await tempRepo({ 'unrelated.txt': 'u' }, 'other')
		trash.push(readerHome, clone.dir)
		const reader = {
			url: base.url,
			store: memStore(),
			peer,
			gitDir: clone.gitDir,
			home: readerHome,
			log: () => {},
		}
		const listed = await converse(['list'], reader)
		expect(listed).toContain(`${sha2} refs/heads/@${fake.identityKey}/main`)
		await converse(
			[`fetch ${sha2} refs/heads/@${fake.identityKey}/main`],
			reader,
		)
		const proc = Bun.spawn(
			['git', '--git-dir', clone.gitDir, 'cat-file', '-t', sha2],
			{ stdout: 'pipe', stderr: 'pipe' },
		)
		expect(await new Response(proc.stdout).text()).toBe('commit\n')
	})
})
