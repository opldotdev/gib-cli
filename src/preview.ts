/**
 * The dry run.
 *
 * Before a push spends anything it plans the whole tree, packs it into
 * transactions that are built but never funded or broadcast, and resolves
 * the result back out of a scratch store with the real reader. What that
 * checks is the thing that matters: that the published root, with `.git`
 * stripped, is the tree git hashed.
 *
 * The transaction ids differ from the ones the wallet will produce, so
 * this proves the shape, not the bytes. The bytes are checked against the
 * plan when the wallet hands the real transaction back (see packContent).
 */

import { Transaction } from '@bsv/sdk'
import type { PlannedOutput, PublishedTx } from './publish.ts'
import { bLockingScript } from './script.ts'
import type { TxStore } from './txstore.ts'

/** A store that reads through to `backing` and keeps its writes in memory. */
export function overlayStore(backing: TxStore): TxStore {
	const mem = new Map<string, Uint8Array>()
	return {
		async get(txid) {
			return mem.get(txid.toLowerCase()) ?? (await backing.get(txid))
		},
		async put(txid, bytes) {
			mem.set(txid.toLowerCase(), bytes)
		},
	}
}

/** Build the transaction a publisher would, without funding or signing it. */
export async function dryPublish(
	outputs: PlannedOutput[],
): Promise<PublishedTx> {
	const tx = new Transaction()
	for (const o of outputs) {
		tx.addOutput({
			satoshis: 0,
			lockingScript: bLockingScript(o.contentType, o.bytes),
		})
	}
	return {
		txid: tx.id('hex'),
		bytes: new Uint8Array(tx.toBinary()),
		beef: [],
	}
}
