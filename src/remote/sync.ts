/**
 * Syncing with a peer: the two lookups and nothing else.
 *
 * `headsSince` walks one branch forward, oldest first, and every head
 * arrives with its own BEEF, so a head is always stored before the push
 * that spends it. `txs` fetches whole transactions in batches, which is
 * how the trees those heads point at are filled in.
 *
 * Which branches a repository has is not something either lookup answers —
 * headsSince takes one branch — so the branch list comes from what this
 * client already knows, plus the repository's own `.gib` default branch
 * and the conventional names. See the TODO on branchCandidates.
 */

import { Beef } from '@bsv/sdk'
import { gitHash } from '../git.ts'
import { readHead } from '../head.ts'
import { GIT_DIR, readDir } from '../tree.ts'
import { DIR_CONTENT_TYPE, dirDecode } from '../ordfs/dir.ts'
import { PATCH_CONTENT_TYPE, patchDecode } from '../ordfs/patch.ts'
import { formatOutpoint, type Outpoint, parseOutpoint } from '../outpoint.ts'
import { payloadFromScript } from '../content.ts'
import { GIB_FILE, parseRepoMeta } from '../repo-meta.ts'
import { recordHead, type RepoState } from '../refs.ts'
import { loadTx, resolveOutpoint, resolvePath } from '../resolver.ts'
import type { TxStore } from '../txstore.ts'
import { MAX_PAGES, MAX_TXIDS, type Peer, SyncBrokenError } from './peer.ts'

/** Branch names tried when nothing better is known about a repository. */
export const CONVENTIONAL_BRANCHES = ['main', 'master']

/**
 * Bring the local state up to date with the peer's copy of one branch.
 * Returns the heads that were new here.
 *
 * TODO: a headsSince page is a walk of the branch's chain, and says
 * nothing about whether its last head has since been spent. A branch
 * deleted by burning its head therefore still advertises here, to anyone
 * who learns about it from a peer rather than from their own delete. The
 * overlay knows (it tracks the spend); the answer needs to carry it — a
 * spent flag on each head, or a tombstone for the branch.
 */
export async function pullBranch(
	peer: Peer,
	store: TxStore,
	state: RepoState,
	branch: string,
): Promise<number> {
	let since = state.cursors[branch] ?? ''
	let added = 0
	for (let page1 = 0; ; page1++) {
		if (page1 >= MAX_PAGES) {
			throw new Error(
				`branch ${branch}: the peer is still offering more heads after ${MAX_PAGES} pages`,
			)
		}
		let page: Awaited<ReturnType<Peer['headsSince']>>
		try {
			page = await peer.headsSince({ origin: state.origin, branch, since })
		} catch (e) {
			// A peer that never saw where we stopped cannot resume us: start
			// the branch again rather than mistaking its whole history for
			// new work or giving up on it.
			if (e instanceof SyncBrokenError && e.code === 'unknown-since' && since) {
				since = ''
				delete state.cursors[branch]
				continue
			}
			throw e
		}
		for (const h of page.heads) {
			const stored = await absorbBeef(store, h.beef)
			const txid = parseOutpoint(h.outpoint).txid
			if (!stored.includes(txid)) {
				// The outpoints are index-aligned with the outputs; a peer
				// whose BEEF does not hold the head it is answering about
				// has given us something we cannot use.
				throw new Error(
					`the peer's BEEF for head ${h.outpoint} does not contain ${txid}`,
				)
			}
			const head = await readHead(store, h.outpoint)
			if (head.token.origin !== state.origin || head.token.branch !== branch) {
				continue
			}
			// A head names no commit: the commit it publishes is in its
			// tree. Record the head now and read the sha once, for the
			// branch's newest head only, when the walk is done.
			recordHead(state, {
				identity: head.token.identityPubkey,
				branch,
				head: head.outpoint,
				sha: '',
				root: head.token.root,
			})
			state.cursors[branch] = h.outpoint
			added++
		}
		if (!page.more || page.heads.length === 0) {
			await resolveShas(peer, store, state, branch)
			return added
		}
		const next = page.heads[page.heads.length - 1].outpoint
		if (next === since) {
			throw new Error(`branch ${branch}: the peer is not advancing past ${since}`)
		}
		since = next
	}
}

/**
 * Fill in the commit sha of each publisher's newest head on a branch. It
 * lives in the head's tree, so this is the one place a ref listing has to
 * read content — once per branch, not once per head.
 */
async function resolveShas(
	peer: Peer,
	store: TxStore,
	state: RepoState,
	branch: string,
): Promise<void> {
	for (const ref of Object.values(state.refs)) {
		if (ref.branch !== branch || ref.sha) continue
		try {
			ref.sha = await tipShaFrom(peer, store, parseOutpoint(ref.root))
		} catch (e) {
			// Without the sha there is nothing to advertise; the ref stays
			// recorded, so a later refresh can try again.
			state.warnings.push(
				`head ${ref.head}: ${e instanceof Error ? e.message : e}`,
			)
		}
	}
}

/**
 * The commit a published root publishes, fetching only what it takes to
 * read it: the root manifest, the `.git` manifest, and the tip commit.
 */
export async function tipShaFrom(
	peer: Peer | undefined,
	store: TxStore,
	root: Outpoint,
): Promise<string> {
	await ensureTxs(store, peer, [root.txid])
	const gitEntry = (await readDir(store, root)).find(
		(e) => e.name === GIT_DIR && e.isDir,
	)
	if (!gitEntry) throw new Error(`published root has no ${GIT_DIR} store`)
	await ensureTxs(store, peer, [gitEntry.outpoint.txid])
	const tip = (await readDir(store, gitEntry.outpoint)).find((e) => e.name === '.')
	if (!tip) throw new Error(`${GIT_DIR} names no tip commit`)
	await ensureTxs(store, peer, [tip.outpoint.txid])
	const payload = await resolveOutpoint(store, tip.outpoint)
	return gitHash('commit', payload.bytes)
}

/**
 * Refresh every branch this client can name. Returns the number of heads
 * that were new.
 */
export async function pullRepo(
	peer: Peer,
	store: TxStore,
	state: RepoState,
	extraBranches: string[] = [],
): Promise<number> {
	let added = 0
	for (const branch of await branchCandidates(peer, store, state, extraBranches)) {
		added += await pullBranch(peer, store, state, branch)
	}
	return added
}

/**
 * The branches to ask a peer about.
 *
 * TODO: ls_gib has no query that enumerates a repository's branches —
 * headsSince takes one branch, and the untyped `heads` query answers with
 * formulas the overlay engine cannot hydrate. Until it grows one, a branch
 * is found from what this client already knows, the local repository's own
 * refs, the genesis tree's `.gib` defaultBranch, and main/master. A
 * repository whose only branch is none of those cannot be cloned blind.
 */
export async function branchCandidates(
	peer: Peer,
	store: TxStore,
	state: RepoState,
	extra: string[] = [],
): Promise<string[]> {
	const names = new Set<string>(state.branches)
	for (const b of extra) if (b) names.add(b)
	if (state.genesis) names.add(state.genesis.branch)
	const meta = await defaultBranchFromGenesis(peer, store, state.origin)
	if (meta) names.add(meta)
	for (const b of CONVENTIONAL_BRANCHES) names.add(b)
	return [...names]
}

/** `.gib` defaultBranch from the repository's genesis tree, when it has one. */
async function defaultBranchFromGenesis(
	peer: Peer,
	store: TxStore,
	origin: string,
): Promise<string | undefined> {
	try {
		const root = parseOutpoint(origin)
		await ensureTxs(store, peer, [root.txid])
		await prefetchTree(store, peer, root)
		const file = await resolvePath(store, root, GIB_FILE)
		return parseRepoMeta(new TextDecoder().decode(file.bytes)).defaultBranch
	} catch {
		return undefined
	}
}

/** Store every transaction a BEEF carries. */
export async function absorbBeef(
	store: TxStore,
	beef: Uint8Array | number[],
): Promise<string[]> {
	const parsed = Beef.fromBinary(Array.from(beef))
	const stored: string[] = []
	for (const btx of parsed.txs) {
		if (!btx.tx) continue
		const txid = btx.tx.id('hex')
		await store.put(txid, new Uint8Array(btx.tx.toBinary()))
		stored.push(txid)
	}
	return stored
}

/** Fetch the transactions the store does not have, in batches. */
export async function ensureTxs(
	store: TxStore,
	peer: Peer | undefined,
	txids: Iterable<string>,
): Promise<void> {
	const missing: string[] = []
	for (const txid of new Set([...txids].map((t) => t.toLowerCase()))) {
		if (!(await store.get(txid))) missing.push(txid)
	}
	if (missing.length === 0) return
	if (!peer) {
		throw new Error(
			`missing ${missing.length} transaction(s) and no peer to ask: ${missing[0]}`,
		)
	}
	for (let i = 0; i < missing.length; i += MAX_TXIDS) {
		const batch = missing.slice(i, i + MAX_TXIDS)
		await absorbBeef(store, await peer.txs(batch))
	}
}

/**
 * Walk a published tree breadth-first, fetching the transactions each
 * level cites before reading it. One `txs` request per level, rather than
 * one per file, is the whole point of the query.
 */
export async function prefetchTree(
	store: TxStore,
	peer: Peer | undefined,
	root: Outpoint,
	maxDepth = 64,
): Promise<void> {
	let level: Outpoint[] = [root]
	const seen = new Set<string>()
	for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
		await ensureTxs(store, peer, level.map((op) => op.txid))
		const next: Outpoint[] = []
		for (const op of level) {
			const key = formatOutpoint(op)
			if (seen.has(key)) continue
			seen.add(key)
			const children = await childOutpoints(store, op)
			for (const child of children) {
				if (!seen.has(formatOutpoint(child))) next.push(child)
			}
		}
		level = next
	}
}

/** The outpoints an output points at: directory entries, or a patch base. */
async function childOutpoints(
	store: TxStore,
	op: Outpoint,
): Promise<Outpoint[]> {
	let payload: ReturnType<typeof payloadFromScript>
	try {
		const tx = await loadTx(store, op.txid)
		const out = tx.outputs[op.vout]
		if (!out) return []
		payload = payloadFromScript(out.lockingScript)
	} catch {
		return []
	}
	if (!payload) return []
	if (payload.contentType === PATCH_CONTENT_TYPE) {
		try {
			return [patchDecode(payload.bytes).base]
		} catch {
			return []
		}
	}
	if (payload.contentType !== DIR_CONTENT_TYPE) return []
	try {
		return dirDecode(payload.bytes).entries.map((e) =>
			e.ref.kind === 'same-tx'
				? { txid: op.txid, vout: e.ref.vout }
				: { txid: e.ref.txid.toLowerCase(), vout: e.ref.vout },
		)
	} catch {
		return []
	}
}
