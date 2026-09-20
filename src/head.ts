/**
 * Reading commit heads out of the transactions that carry them.
 *
 * A head is a 1-satoshi PushDrop output with the commit object inscribed
 * beside it, spending the head before it on the same branch. That spend
 * chain is the branch's history, so walking it backwards is how a fetch
 * finds parents.
 */

import { payloadFromScript } from './content.ts'
import { gitHash } from './git.ts'
import { formatOutpoint, type Outpoint, parseOutpoint } from './outpoint.ts'
import { loadTx } from './resolver.ts'
import { type CommitToken, decodeCommitToken } from './token.ts'
import type { TxStore } from './txstore.ts'

export type Head = {
	outpoint: string
	token: CommitToken
	/** The raw git commit object inscribed on the head. */
	commit: Uint8Array
	sha: string
	root: Outpoint
}

/** Read the head at an outpoint, or throw when it is not one. */
export async function readHead(
	store: TxStore,
	outpoint: string,
): Promise<Head> {
	const op = parseOutpoint(outpoint)
	const tx = await loadTx(store, op.txid)
	const out = tx.outputs[op.vout]
	if (!out) throw new Error(`missing head ${outpoint}`)
	const payload = payloadFromScript(out.lockingScript)
	if (!payload) throw new Error(`head ${outpoint} has no inscription`)
	const token = decodeCommitToken(out.lockingScript)
	return {
		outpoint: formatOutpoint(op, '_'),
		token,
		commit: payload.bytes,
		sha: gitHash('commit', payload.bytes),
		root: parseOutpoint(token.root),
	}
}

/**
 * The head this head spent — the previous commit on the branch — or
 * undefined for a genesis, or when the spent transaction is not held
 * locally.
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
