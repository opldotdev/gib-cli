/**
 * Reading commit heads.
 *
 * A head is a bare 1-satoshi PushDrop naming a repository origin, a
 * branch, a published root and its publisher, and spending the branch's
 * previous head. Nothing is inscribed on it: the commit it publishes is
 * the tip commit object inside the root's `.git` store, which the `.`
 * default entry points at.
 *
 * So reading a head's *token* costs nothing but the head transaction,
 * while reading the commit it publishes costs the root and `.git` as well.
 * Keep the two apart: `list` only needs the sha of a branch's newest head,
 * not of every head on its chain.
 */

import { gitHash } from './git.ts'
import { formatOutpoint, type Outpoint, parseOutpoint } from './outpoint.ts'
import { loadTx, resolvePath } from './resolver.ts'
import { type CommitToken, decodeCommitToken } from './token.ts'
import { GIT_DIR } from './tree.ts'
import type { TxStore } from './txstore.ts'

export type Head = {
	outpoint: string
	token: CommitToken
	root: Outpoint
}

/** The head at an outpoint, or a throw when it is not one. */
export async function readHead(
	store: TxStore,
	outpoint: string,
): Promise<Head> {
	const op = parseOutpoint(outpoint)
	const tx = await loadTx(store, op.txid)
	const out = tx.outputs[op.vout]
	if (!out) throw new Error(`missing head ${outpoint}`)
	const token = decodeCommitToken(out.lockingScript)
	return {
		outpoint: formatOutpoint(op, '_'),
		token,
		root: parseOutpoint(token.root),
	}
}

/**
 * The tip commit object of a published root: the `.` default entry of its
 * `.git` store. Needs the root's content, not just the head.
 */
export async function tipCommit(
	store: TxStore,
	root: Outpoint,
): Promise<Uint8Array> {
	const resolved = await resolvePath(store, root, GIT_DIR)
	return resolved.bytes
}

/** The commit sha a published root's tip commit object hashes to. */
export async function tipSha(
	store: TxStore,
	root: Outpoint,
): Promise<string> {
	return gitHash('commit', await tipCommit(store, root))
}

/**
 * The head this head spent — the branch's previous push — or undefined for
 * a first head, or when the spent transaction is not held locally.
 */
export async function previousHead(
	store: TxStore,
	outpoint: string,
): Promise<string | undefined> {
	const op = parseOutpoint(outpoint)
	const tx = await loadTx(store, op.txid)
	const self = tx.outputs[op.vout]
	if (!self) throw new Error(`missing head ${outpoint}`)
	let token: CommitToken | undefined
	try {
		token = decodeCommitToken(self.lockingScript)
	} catch {
		token = undefined
	}
	for (const input of tx.inputs) {
		const src = input.sourceTXID
		if (!src) continue
		try {
			const sourceTx = await loadTx(store, src)
			const out = sourceTx.outputs[input.sourceOutputIndex]
			if (!out || out.satoshis !== 1) continue
			const prev = decodeCommitToken(out.lockingScript)
			if (token && (prev.origin !== token.origin || prev.branch !== token.branch)) {
				continue
			}
			return `${src.toLowerCase()}_${input.sourceOutputIndex}`
		} catch {
			// not a commit head, or its transaction is not here
		}
	}
	return undefined
}
