/**
 * The commit chain.
 *
 * A push of N commits publishes N heads, each spending the last, each
 * carrying its own commit object and its own root tree: the branch's spend
 * chain *is* the commit history, with no gaps for a later pull to trip
 * over. This module builds the content those heads point at.
 *
 * Content for the whole push goes in as few transactions as possible —
 * ideally one — with each commit's tree planned against the one before it,
 * inside the same transaction where it can be. A directory's
 * same-transaction reference is a single byte, so a transaction cannot
 * carry more than 256 outputs; when the next commit would not fit, the
 * transaction is published and the chain carries on in a new one, where
 * the previous tree is now citable (and patchable) at real outpoints.
 */

import {
	MAX_SAME_TX_VOUT,
	type IncomingFile,
	type PlannedOutput,
	type Tree,
	bindTree,
	planCommit,
} from './cascade.ts'
import { treeShaFromCommit } from './gitread.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import { previewContentStore } from './preview.ts'
import type { Publisher, PublishedTx } from './publish.ts'
import { bLockingScript } from './script.ts'
import { collectTree, materializeGit } from './tree.ts'
import type { TxStore } from './txstore.ts'
import { Transaction } from '@bsv/sdk'

/** One commit to publish, as git has it. */
export type ChainCommit = {
	sha: string
	/** The raw git commit object, inscribed on its head. */
	commit: Uint8Array
	files: IncomingFile[]
}

export type PublishedContent = {
	/** Root outpoint of each commit's tree, by commit sha. */
	roots: Map<string, Outpoint>
	/** The content transactions published, in order. */
	txs: PublishedTx[]
	/** The tree the last commit in the chain published. */
	tree: Tree
	/** Transactions reused from a previous, interrupted attempt. */
	reused: number
}

export type ChainOptions = {
	commits: ChainCommit[]
	/** Tree of the commit the branch's current head publishes. */
	prevTree?: Tree
	store: TxStore
	publisher: Publisher
	labels: string[]
	/** Where a commit's tree is checked against its git tree sha. */
	scratchGitDir: string
	/** Content transactions from an interrupted push, in order. */
	pending?: PublishedTx[]
	/** Outputs one content transaction may carry. */
	maxOutputs?: number
	log?: (s: string) => void
}

/** Same-transaction vouts are one byte, so 256 outputs is the hard ceiling. */
export const MAX_CONTENT_OUTPUTS = MAX_SAME_TX_VOUT + 1

/**
 * Plan and publish the content for a chain of commits, checking each
 * commit's tree against the tree sha the commit names before anything is
 * minted.
 */
export async function publishChain(
	opts: ChainOptions,
): Promise<PublishedContent> {
	const max = opts.maxOutputs ?? MAX_CONTENT_OUTPUTS
	const roots = new Map<string, Outpoint>()
	const txs: PublishedTx[] = []
	let reused = 0
	let tree = opts.prevTree
	let pendingOutputs: PlannedOutput[] = []
	let pendingCommits: Array<{ sha: string; rootIndex: number; commit: Uint8Array }> = []

	const flush = async (): Promise<void> => {
		if (pendingOutputs.length === 0) return
		// Check every tree in this transaction against its commit before a
		// single satoshi moves: the published tree must be byte-identical to
		// git's, or the commit sha would not verify.
		const preview = previewContentStore(pendingOutputs, opts.store)
		for (const c of pendingCommits) {
			await validateTree(
				preview.store,
				{ txid: preview.txid, vout: c.rootIndex },
				c.commit,
				opts.scratchGitDir,
			)
		}
		const reuse = matchPending(opts.pending?.[txs.length], pendingOutputs)
		const tx =
			reuse ??
			(await opts.publisher.publishContent(
				pendingOutputs,
				opts.labels,
				pendingCommits[pendingCommits.length - 1].sha,
			))
		if (reuse) {
			reused++
			opts.log?.(`gib: reusing content transaction ${reuse.txid}\n`)
		}
		await opts.store.put(tx.txid, tx.bytes)
		txs.push(tx)
		for (const c of pendingCommits) {
			roots.set(c.sha, { txid: tx.txid, vout: c.rootIndex })
		}
		if (tree) tree = bindTree(tree, tx.txid)
		pendingOutputs = []
		pendingCommits = []
	}

	for (const c of opts.commits) {
		let plan = await planCommit({
			files: c.files,
			prev: tree,
			baseVout: pendingOutputs.length,
		})
		if (pendingOutputs.length > 0 && pendingOutputs.length + plan.outputs.length > max) {
			await flush()
			plan = await planCommit({ files: c.files, prev: tree, baseVout: 0 })
		}
		if (plan.outputs.length > max) {
			// TODO: an `ordfs/dir` same-transaction reference is one byte, so
			// a single commit cannot publish more than 256 new objects at
			// once. Splitting one commit's tree across transactions needs the
			// dir format to grow a wider same-tx reference, or the planner to
			// publish deep subtrees as their own transactions first.
			throw new Error(
				`commit ${c.sha} needs ${plan.outputs.length} outputs; one content transaction holds at most ${max}`,
			)
		}
		pendingOutputs.push(...plan.outputs)
		pendingCommits.push({ sha: c.sha, rootIndex: plan.rootIndex, commit: c.commit })
		tree = plan.tree
	}
	await flush()
	if (!tree) throw new Error('chain: nothing to publish')
	return { roots, txs, tree, reused }
}

/**
 * A content transaction from an interrupted push is reused only when it
 * carries exactly the outputs now planned, in order. The wallet's change
 * output sits after them.
 */
function matchPending(
	candidate: PublishedTx | undefined,
	outputs: PlannedOutput[],
): PublishedTx | undefined {
	if (!candidate) return undefined
	let tx: Transaction
	try {
		tx = Transaction.fromBinary(Array.from(candidate.bytes))
	} catch {
		return undefined
	}
	if (tx.outputs.length < outputs.length) return undefined
	for (let i = 0; i < outputs.length; i++) {
		const want = bLockingScript(outputs[i].contentType, outputs[i].bytes).toHex()
		if (tx.outputs[i].lockingScript.toHex() !== want) return undefined
	}
	return candidate
}

/**
 * Resolve a published root and compare it with the tree sha the commit
 * names. Nothing extra goes in the published tree, so the two must match
 * byte for byte.
 */
export async function validateTree(
	store: TxStore,
	root: Outpoint,
	commitBytes: Uint8Array,
	scratchGitDir: string,
): Promise<void> {
	const files = await collectTree(store, root)
	const got = await materializeGit(scratchGitDir, files, commitBytes)
	const want = treeShaFromCommit(commitBytes)
	if (got.tree !== want) {
		throw new Error(
			`validation: resolved tree ${got.tree} != commit tree ${want} (root ${formatOutpoint(root)})`,
		)
	}
}
