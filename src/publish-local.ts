import { Transaction } from '@bsv/sdk'
import type { CommitPlan } from './cascade.ts'
import type { Publisher, PublishedTx } from './publish.ts'
import { GIT_COMMIT_TYPE, appendOrdEnvelope, bLockingScript } from './script.ts'
import { sealCommitLock } from './seal.ts'

export function localPublisher(wallet: Pick<import('@bsv/sdk').WalletInterface, 'getPublicKey' | 'createSignature'>): Publisher {
	return {
		async publishContent(plan: CommitPlan): Promise<PublishedTx> {
			const tx = new Transaction()
			for (const o of plan.outputs) {
				tx.addOutput({
					satoshis: 0,
					lockingScript: bLockingScript(o.contentType, o.bytes),
				})
			}
			return { txid: tx.id('hex'), bytes: new Uint8Array(tx.toBinary()) }
		},
		async publishHead(opts) {
			const pd = await sealCommitLock(wallet, opts.token)
			const locking = appendOrdEnvelope(pd, GIT_COMMIT_TYPE, opts.commitBytes)
			const tx = new Transaction()
			tx.addOutput({ satoshis: 1, lockingScript: locking })
			return { txid: tx.id('hex'), bytes: new Uint8Array(tx.toBinary()) }
		},
		async burnHead() {
			const tx = new Transaction()
			tx.addOutput({
				satoshis: 1,
				lockingScript: bLockingScript('text/plain', new Uint8Array([1])),
			})
			return { txid: tx.id('hex'), bytes: new Uint8Array(tx.toBinary()) }
		},
	}
}
