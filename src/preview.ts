import { Transaction } from '@bsv/sdk'
import type { PlannedOutput } from './cascade.ts'
import { bLockingScript } from './script.ts'
import type { Outpoint } from './outpoint.ts'
import type { TxStore } from './txstore.ts'

/**
 * The content transaction as it will be, before the wallet funds it: the
 * planned outputs in order, which is the order the wallet keeps
 * (`randomizeOutputs: false`), so every vout a manifest names is already
 * right. Its txid is not the real one, so the store layered here is only
 * good for reading this tree back and checking it against the commit.
 */
export function previewContentStore(
	outputs: PlannedOutput[],
	backing: TxStore,
): { store: TxStore; txid: string; bytes: Uint8Array } {
	const tx = new Transaction()
	for (const o of outputs) {
		tx.addOutput({
			satoshis: 0,
			lockingScript: bLockingScript(o.contentType, o.bytes),
		})
	}
	const bytes = new Uint8Array(tx.toBinary())
	const txid = tx.id('hex')
	const store: TxStore = {
		async get(id) {
			if (id.toLowerCase() === txid) return bytes
			return backing.get(id)
		},
		async put(id, b) {
			return backing.put(id, b)
		},
	}
	return { store, txid, bytes }
}

/** Where a planned root sits in the preview transaction. */
export function previewRoot(txid: string, rootIndex: number): Outpoint {
	return { txid, vout: rootIndex }
}
