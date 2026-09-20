/**
 * The git remote-helper protocol for gib: capabilities, list, fetch, push.
 *
 * A git remote is one peer on one repository origin
 * (`gib://<host>/<repository origin>`). `list` refreshes every publisher's
 * heads from the peer and advertises the user's own as
 * `refs/heads/<branch>` and every other publisher's as
 * `refs/heads/@<identity>/<branch>`. `fetch` walks a branch's spend chain
 * back into git. `push` mints through the wallet and submits to the peer.
 *
 * Nothing here validates a chain: the peer's overlay does that, and this
 * client asked it for what it got.
 */

import type { WalletInterface } from '@bsv/sdk'
import { importHistory } from '../fetch.ts'
import { loadIdentity, saveIdentity } from '../identity.ts'
import { pushLine } from '../push.ts'
import { type Publisher, walletPublisher } from '../publish.ts'
import {
	emptyRepoState,
	forgetHead,
	loadRepoState,
	recordHead,
	type RepoState,
	saveRepoState,
} from '../refs.ts'
import { readHead } from '../head.ts'
import { NULL_SHA } from '../token.ts'
import type { TxStore } from '../txstore.ts'
import { advertise, chooseHead, type Ref, splitRef } from './advertise.ts'
import type { Peer } from './peer.ts'
import { pullRepo } from './sync.ts'
import { parseGibUrl } from './url.ts'

export type HelperIo = {
	read: () => Promise<string | null>
	write: (s: string) => void
}

export type HelperOptions = {
	url: string
	store: TxStore
	/** The peer the URL names, when it names one. */
	peer?: Peer
	/** Connects the wallet; only a push needs one. */
	wallet?: () => Promise<WalletInterface>
	/** Overrides the wallet-backed publisher (tests). */
	publisher?: Publisher
	gitDir: string
	io: HelperIo
	home?: string
	/** Where progress lines go; git relays stderr to the user. */
	log?: (s: string) => void
	/** Branch names the local repository knows, to help a first refresh. */
	localBranches?: string[]
}

export async function runHelper(opts: HelperOptions): Promise<void> {
	const { origin } = parseGibUrl(opts.url)
	const log = opts.log ?? ((s: string) => process.stderr.write(s))
	const state = await loadRepoState(origin, opts.home)
	let identity = await loadIdentity(opts.home)

	/**
	 * Refresh from the peer and advertise.
	 *
	 * For a push it is the *peer's* own view that git must compare against,
	 * not everything this client knows: a head minted here and never sent
	 * (a repository straight out of `gib init`, or a second remote added
	 * later) would otherwise look to git like something the remote already
	 * has, and git would send nothing. So the peer's answer is collected
	 * into a state of its own, and merged into ours afterwards.
	 */
	const refresh = async (forPush = false): Promise<Ref[]> => {
		if (!opts.peer) return advertise(state, identity)
		const view = forPush ? emptyRepoState(origin) : state
		if (forPush) view.branches = [...state.branches]
		try {
			const added = await pullRepo(
				opts.peer,
				opts.store,
				view,
				opts.localBranches ?? [],
			)
			if (added > 0 && !forPush) {
				log(`gib: fetched ${added} head(s) from the remote\n`)
			}
		} catch (e) {
			log(`gib: ${e instanceof Error ? e.message : e}\n`)
		}
		if (forPush) mergeState(state, view)
		await saveRepoState(state, opts.home)
		return advertise(view, identity)
	}

	for (;;) {
		const line = await opts.io.read()
		if (line === null) return
		const cmd = line.trim()
		if (cmd === '') continue
		if (cmd === 'capabilities') {
			opts.io.write('fetch\npush\n\n')
			continue
		}
		if (cmd === 'list' || cmd === 'list for-push') {
			const refs = await refresh(cmd === 'list for-push')
			for (const r of refs) opts.io.write(`${r.sha} ${r.name}\n`)
			const head = chooseHead(refs, state, identity)
			if (head) opts.io.write(`@${head} HEAD\n`)
			opts.io.write('\n')
			continue
		}
		if (cmd.startsWith('fetch ')) {
			const lines = [cmd, ...(await readUntilBlank(opts.io))]
			for (const l of lines) {
				const [, sha, ref] = l.split(' ')
				await fetchRef(opts, state, identity, sha, ref ?? '', log)
			}
			await saveRepoState(state, opts.home)
			opts.io.write('\n')
			continue
		}
		if (cmd.startsWith('push ')) {
			const lines = [cmd, ...(await readUntilBlank(opts.io))]
			let wallet: WalletInterface | undefined
			try {
				if (!opts.wallet) throw new Error('no wallet configured')
				wallet = await opts.wallet()
				const got = await wallet.getPublicKey({ identityKey: true })
				identity = got.publicKey
				await saveIdentity(identity, opts.home).catch(() => {})
			} catch (e) {
				for (const l of lines) {
					opts.io.write(`error ${dstOf(l)} ${oneLine(e)}\n`)
				}
				opts.io.write('\n')
				continue
			}
			await refresh(true)
			const publisher = opts.publisher ?? walletPublisher(wallet)
			for (const l of lines) {
				const r = await pushLine(l, {
					gitDir: opts.gitDir,
					store: opts.store,
					wallet,
					publisher,
					origin,
					identity,
					peer: opts.peer,
					have: ourShas(state, identity),
					home: opts.home,
					log,
				})
				if (!r.ok) {
					opts.io.write(`error ${r.dst} ${r.error}\n`)
					continue
				}
				if (r.sha === NULL_SHA) forgetHead(state, identity, r.branch)
				else if (r.head) {
					const head = await readHead(opts.store, r.head)
					recordHead(state, {
						identity,
						branch: r.branch,
						head: r.head,
						sha: r.sha,
						root: head.token.root,
					})
				}
				opts.io.write(`ok ${r.dst}\n`)
			}
			await saveRepoState(state, opts.home)
			opts.io.write('\n')
			continue
		}
		throw new Error(`git-remote-gib: unsupported command ${cmd}`)
	}
}

/** Fold a peer's view of a repository into what this client keeps. */
function mergeState(state: RepoState, view: RepoState): void {
	for (const r of Object.values(view.refs)) recordHead(state, r)
	for (const [branch, cursor] of Object.entries(view.cursors)) {
		state.cursors[branch] = cursor
	}
}

/** Import the history behind one advertised ref. */
async function fetchRef(
	opts: HelperOptions,
	state: RepoState,
	identity: string,
	sha: string,
	ref: string,
	log: (s: string) => void,
): Promise<void> {
	let head = headFor(state, identity, sha, ref)
	if (!head && opts.peer) {
		await pullRepo(opts.peer, opts.store, state, opts.localBranches ?? [])
		head = headFor(state, identity, sha, ref)
	}
	if (!head) {
		throw new Error(
			`git-remote-gib: no head on ${state.origin} publishes commit ${sha}`,
		)
	}
	const imported = await importHistory(opts.store, opts.gitDir, head, {
		peer: opts.peer,
	})
	log(`gib: imported ${imported.length} commit(s) for ${sha.slice(0, 12)}\n`)
}

function headFor(
	state: RepoState,
	identity: string,
	sha: string,
	ref: string,
): string | undefined {
	if (ref) {
		try {
			const { publisher, branch } = splitRef(ref, identity)
			for (const r of Object.values(state.refs)) {
				if (r.branch === branch && r.identity === publisher && r.sha === sha) {
					return r.head
				}
			}
		} catch {
			// fall through to the sha search
		}
	}
	return Object.values(state.refs).find((r) => r.sha === sha)?.head
}

/**
 * The commits this identity's own head chains already publish.
 *
 * Only our own: a branch's spend chain has to carry that branch's whole
 * history, so a commit another publisher minted still needs a head of
 * ours before our branch can point past it. Its content is cited, not
 * rewritten, so what that costs is a head, not a tree.
 */
function ourShas(state: RepoState, identity: string): string[] {
	if (!identity) return []
	return Object.values(state.refs)
		.filter((r) => r.identity === identity)
		.map((r) => r.sha)
}

async function readUntilBlank(io: HelperIo): Promise<string[]> {
	const lines: string[] = []
	for (;;) {
		const line = await io.read()
		if (line === null || line.trim() === '') break
		lines.push(line.trim())
	}
	return lines
}

function dstOf(line: string): string {
	return line.slice(line.lastIndexOf(':') + 1)
}

function oneLine(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e)
	return text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
}
