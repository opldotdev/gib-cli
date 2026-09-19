import { Transaction } from '@bsv/sdk'
import type { CommitPlan } from './cascade.ts'
import { bLockingScript } from './script.ts'
import type { Outpoint } from './outpoint.ts'
import type { TxStore } from './txstore.ts'

export function previewContentStore(
	plan: CommitPlan,
	backing: TxStore,
): { store: TxStore; root: Outpoint; bytes: Uint8Array } {
	const tx = new Transaction()
	for (const o of plan.outputs) {
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
	return { store, root: { txid, vout: plan.rootIndex }, bytes }
}
