/**
 * Packing a plan into transactions.
 *
 * A plan is nodes in dependency order with references by node. Packing
 * assigns each node an output: nodes are laid down in order, a transaction
 * at a time, and a reference is a same-transaction vout when its target
 * landed in the same transaction and a full outpoint when it landed in an
 * earlier one. That ordering is what makes it safe — a node's dependencies
 * are always before it, so they are already placed.
 *
 * A same-transaction reference is one byte, so a transaction carries at
 * most 256 outputs. Nothing about a tree has to fit in one transaction:
 * when the next node will not fit, the transaction is published and the
 * rest carries on in a new one, citing what came before by outpoint.
 */

import {
	encodePlannedDir,
	MAX_SAME_TX_VOUT,
	type Plan,
	type PlanRef,
	toDirEntry,
} from './cascade.ts'
import { DIR_CONTENT_TYPE, type DirRef } from './ordfs/dir.ts'
import type { Outpoint } from './outpoint.ts'
import type { PlannedOutput, PublishedTx } from './publish.ts'
import { bLockingScript } from './script.ts'
import type { TxStore } from './txstore.ts'
import { Transaction } from '@bsv/sdk'

/** Same-transaction vouts are one byte, so 256 outputs is the ceiling. */
export const MAX_CONTENT_OUTPUTS = MAX_SAME_TX_VOUT + 1

export type PackedContent = {
	/** Where each planned node ended up. */
	outpoints: Map<number, Outpoint>
	/** The transactions published, in order. */
	txs: PublishedTx[]
	/** Transactions reused from a previous, interrupted attempt. */
	reused: number
}

export type PackOptions = {
	plan: Plan
	store: TxStore
	/** Publishes one transaction's worth of outputs. */
	publish: (outputs: PlannedOutput[]) => Promise<PublishedTx>
	/** Content transactions from an interrupted push, in order. */
	pending?: PublishedTx[]
	maxOutputs?: number
	onContent?: (txs: PublishedTx[]) => Promise<void>
	log?: (s: string) => void
}

export async function packContent(opts: PackOptions): Promise<PackedContent> {
	const max = Math.min(opts.maxOutputs ?? MAX_CONTENT_OUTPUTS, MAX_CONTENT_OUTPUTS)
	const nodes = opts.plan.nodes
	const outpoints = new Map<number, Outpoint>()
	const txs: PublishedTx[] = []
	let reused = 0

	for (let start = 0; start < nodes.length; start += max) {
		const end = Math.min(start + max, nodes.length)
		const here = new Map<number, number>()
		for (let id = start; id < end; id++) here.set(id, id - start)

		const resolve = (ref: PlanRef): DirRef => {
			if (ref.kind !== 'node') return ref
			const vout = here.get(ref.id)
			if (vout !== undefined) return { kind: 'same-tx', vout }
			const op = outpoints.get(ref.id)
			if (!op) {
				throw new Error(`pack: node ${ref.id} referenced before it was placed`)
			}
			return { kind: 'outpoint', txid: op.txid, vout: op.vout }
		}

		const outputs: PlannedOutput[] = []
		for (let id = start; id < end; id++) {
			const node = nodes[id]
			outputs.push(
				node.kind === 'data'
					? { contentType: node.contentType, bytes: node.bytes, path: node.label }
					: {
							contentType: DIR_CONTENT_TYPE,
							bytes: encodePlannedDir(
								node.entries.map((e) => toDirEntry(e, resolve(e.ref))),
							),
							path: node.label,
						},
			)
		}

		const reuse = matchPending(opts.pending?.[txs.length], outputs)
		const tx = reuse ?? (await opts.publish(outputs))
		if (reuse) {
			reused++
			opts.log?.(`gib: reusing content transaction ${reuse.txid}\n`)
		} else if (!carriesOutputs(tx, outputs)) {
			// Every same-transaction reference just encoded is a raw vout. A
			// wallet that reordered the outputs, or put change anywhere but
			// last, would leave every directory pointing at the wrong thing
			// — and the push would report success. Refuse before any of it
			// is used.
			throw new Error(
				`wallet returned ${tx.txid} without the planned outputs in order (randomizeOutputs must be honoured)`,
			)
		}
		await opts.store.put(tx.txid, tx.bytes)
		txs.push(tx)
		// Record it now, not at the end: a push interrupted after this
		// transaction must not pay to publish the same content again.
		await opts.onContent?.([...txs])
		for (let id = start; id < end; id++) {
			outpoints.set(id, { txid: tx.txid, vout: id - start })
		}
	}
	return { outpoints, txs, reused }
}

/**
 * True when a transaction carries exactly these outputs, in order, from
 * vout 0. The wallet's change output sits after them.
 */
function carriesOutputs(
	published: PublishedTx,
	outputs: PlannedOutput[],
): boolean {
	let tx: Transaction
	try {
		tx = Transaction.fromBinary(Array.from(published.bytes))
	} catch {
		return false
	}
	if (tx.outputs.length < outputs.length) return false
	for (let i = 0; i < outputs.length; i++) {
		const want = bLockingScript(outputs[i].contentType, outputs[i].bytes).toHex()
		if (tx.outputs[i].lockingScript.toHex() !== want) return false
	}
	return true
}

/**
 * A content transaction from an interrupted push is reused only when it
 * carries exactly the outputs now planned, in order.
 */
function matchPending(
	candidate: PublishedTx | undefined,
	outputs: PlannedOutput[],
): PublishedTx | undefined {
	if (!candidate) return undefined
	return carriesOutputs(candidate, outputs) ? candidate : undefined
}
