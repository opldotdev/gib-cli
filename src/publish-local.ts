/**
 * A publisher that mints nothing: it builds the same transactions the
 * wallet publisher would, unfunded and unsigned, so tests can exercise the
 * planning, chaining and tree code without a wallet. The head chain is
 * real — each head transaction spends the previous head — so history walks
 * over it the same way it walks over the chain a wallet produced.
 */

import { Beef, Script, Transaction, type WalletInterface } from '@bsv/sdk'
import type { PlannedOutput } from './cascade.ts'
import type { Publisher, PublishedHead, PublishedTx } from './publish.ts'
import { GIT_COMMIT_TYPE, appendOrdEnvelope, bLockingScript } from './script.ts'
import { sealCommitLock } from './seal.ts'

type SealWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

function publishedLocal(tx: Transaction): PublishedTx {
	const beef = new Beef()
	beef.mergeTransaction(tx)
	return {
		txid: tx.id('hex'),
		bytes: new Uint8Array(tx.toBinary()),
		beef: beef.toBinary(),
	}
}

export function localPublisher(wallet: SealWallet): Publisher {
	return {
		async publishContent(outputs: PlannedOutput[]): Promise<PublishedTx> {
			const tx = new Transaction()
			for (const o of outputs) {
				tx.addOutput({
					satoshis: 0,
					lockingScript: bLockingScript(o.contentType, o.bytes),
				})
			}
			return publishedLocal(tx)
		},
		async publishHead(opts): Promise<PublishedHead> {
			const pd = await sealCommitLock(wallet, opts.token)
			const locking = appendOrdEnvelope(pd, GIT_COMMIT_TYPE, opts.commitBytes)
			const tx = new Transaction()
			if (opts.spend) {
				const [txid, vout] = opts.spend.outpoint.split(/[._]/)
				tx.addInput({
					sourceTXID: txid,
					sourceOutputIndex: Number(vout),
					unlockingScript: new Script(),
					sequence: 0xffffffff,
				})
			}
			tx.addOutput({ satoshis: 1, lockingScript: locking })
			return { ...publishedLocal(tx), vout: 0 }
		},
		async burnHead(opts): Promise<PublishedTx> {
			const tx = new Transaction()
			const [txid, vout] = opts.outpoint.split(/[._]/)
			tx.addInput({
				sourceTXID: txid,
				sourceOutputIndex: Number(vout),
				unlockingScript: new Script(),
				sequence: 0xffffffff,
			})
			tx.addOutput({
				satoshis: 1,
				lockingScript: bLockingScript('text/plain', new Uint8Array([1])),
			})
			return publishedLocal(tx)
		},
	}
}
