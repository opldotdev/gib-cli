/**
 * `git fetch` for gib: materialise the commit each head publishes, and
 * walk the branch's spend chain backwards until git already has the
 * parents.
 *
 * Every head carries its own commit and its own root tree, so a fetch is a
 * walk, not a replay: one head, one commit, one tree. Parents on other
 * branches (merges) are not on this chain; they are found when that branch
 * is fetched. A parent no reachable head carries stays missing and git
 * says so.
 */

import { readHead, previousHead } from './head.ts'
import { hasObject as gitHasObject, treeShaFromCommit } from './gitread.ts'
import { parseOutpoint } from './outpoint.ts'
import { ensureTxs, prefetchTree } from './remote/sync.ts'
import type { Peer } from './remote/peer.ts'
import { loadTx } from './resolver.ts'
import { collectTree, materializeGit } from './tree.ts'
import type { TxStore } from './txstore.ts'

export type Imported = {
	commit: string
	tree: string
	parents: string[]
	head: string
}

/** Parent shas from a raw git commit object. */
export function commitParents(commit: Uint8Array): string[] {
	const text = new TextDecoder().decode(commit)
	const header = text.split('\n\n', 1)[0] ?? ''
	return header
		.split('\n')
		.filter((l) => l.startsWith('parent '))
		.map((l) => l.slice(7).trim())
}

/** Write the commit a head publishes into gitDir. */
export async function importCommit(
	store: TxStore,
	gitDir: string,
	headOutpoint: string,
	peer?: Peer,
): Promise<Imported> {
	await ensureTxs(store, peer, [parseOutpoint(headOutpoint).txid])
	const head = await readHead(store, headOutpoint)
	await prefetchTree(store, peer, head.root)
	const files = await collectTree(store, head.root)
	const got = await materializeGit(gitDir, files, head.commit)
	const want = treeShaFromCommit(head.commit)
	if (got.tree !== want) {
		throw new Error(
			`head ${headOutpoint}: resolved tree ${got.tree} does not match commit tree ${want}`,
		)
	}
	return {
		commit: got.commit,
		tree: got.tree,
		parents: commitParents(head.commit),
		head: head.outpoint,
	}
}

/**
 * Import the tip's commit and walk back through the heads it spent until
 * every parent of the last imported commit is in git. Tip first.
 */
export async function importHistory(
	store: TxStore,
	gitDir: string,
	tip: string,
	opts: {
		peer?: Peer
		maxDepth?: number
		hasObject?: (sha: string) => Promise<boolean>
	} = {},
): Promise<Imported[]> {
	const hasObject = opts.hasObject ?? ((sha: string) => gitHasObject(gitDir, sha))
	const maxDepth = opts.maxDepth ?? 100_000
	const imported: Imported[] = []
	const seen = new Set<string>()
	let head: string | undefined = tip
	while (head && !seen.has(head) && imported.length < maxDepth) {
		seen.add(head)
		const r = await importCommit(store, gitDir, head, opts.peer)
		imported.push(r)
		let missing = false
		for (const p of r.parents) {
			if (!(await hasObject(p))) {
				missing = true
				break
			}
		}
		if (!missing) break
		head = await previousOnChain(store, head, opts.peer)
	}
	return imported
}

/**
 * The head this one spent. The transaction that made it names its inputs,
 * so a peer can be asked for the ones this client does not hold yet.
 */
async function previousOnChain(
	store: TxStore,
	head: string,
	peer?: Peer,
): Promise<string | undefined> {
	const found = await previousHead(store, head)
	if (found || !peer) return found
	const tx = await loadTx(store, parseOutpoint(head).txid)
	const sources = tx.inputs
		.map((i) => i.sourceTXID)
		.filter((t): t is string => typeof t === 'string')
	if (sources.length === 0) return undefined
	try {
		await ensureTxs(store, peer, sources)
	} catch {
		return undefined
	}
	return previousHead(store, head)
}
