import {
	type CreateActionResult,
	LockingScript,
	PushDrop,
	Transaction,
	type WalletInterface,
} from '@bsv/sdk'
import type { CommitPlan } from './cascade.ts'
import { GIT_COMMIT_TYPE, appendOrdEnvelope, bLockingScript } from './script.ts'
import { commitHeadCustomInstructions, sealCommitLock } from './seal.ts'
import { stampManagedOutputIds } from './ids.ts'
import {
	GIB_BASKET,
	GIB_PROTOCOL,
	branchTag,
	originTag,
	type CommitToken,
} from './token.ts'

export type PublishedTx = { txid: string; bytes: Uint8Array }

export type Publisher = {
	publishContent(plan: CommitPlan, labels: string[]): Promise<PublishedTx>
	publishHead(opts: {
		token: CommitToken
		commitBytes: Uint8Array
		labels: string[]
		tags: string[]
		spend?: { outpoint: string; beef: number[]; keyID: string }
	}): Promise<PublishedTx>
	burnHead(opts: {
		outpoint: string
		beef: number[]
		keyID: string
		labels: string[]
	}): Promise<PublishedTx>
}

function rawTxFromResult(r: CreateActionResult): PublishedTx {
	if (!r.txid) throw new Error('createAction returned no txid')
	if (!r.tx?.length) throw new Error('createAction returned no tx bytes')
	const beef = Array.from(r.tx)
	const tx = Transaction.fromBEEF(beef)
	return { txid: r.txid, bytes: new Uint8Array(tx.toBinary()) }
}

export function walletPublisher(wallet: WalletInterface): Publisher {
	return {
		async publishContent(plan, labels) {
			const outputs = plan.outputs.map((o, i) => ({
				lockingScript: bLockingScript(o.contentType, o.bytes).toHex(),
				satoshis: 0,
				outputDescription: o.path ?? `gib content ${i}`,
			}))
			const args = {
				description: `gib content ${labels[0] ?? ''}`.slice(0, 50),
				outputs,
				labels,
				options: { randomizeOutputs: false, signAndProcess: true },
			}
			const r = await wallet.createAction(args)
			return rawTxFromResult(r)
		},
		async publishHead(opts) {
			if (opts.spend && !opts.spend.keyID) {
				throw new Error('spend missing customInstructions keyID')
			}
			const pd = await sealCommitLock(wallet, opts.token)
			const locking = appendOrdEnvelope(pd, GIT_COMMIT_TYPE, opts.commitBytes)
			const args = {
				description: `gib head ${opts.token.branch}`.slice(0, 50),
				...(opts.spend ? { inputBEEF: opts.spend.beef } : {}),
				inputs: opts.spend
					? [
							{
								outpoint: opts.spend.outpoint,
								inputDescription: 'gib commit token',
								unlockingScriptLength: 73,
							},
						]
					: undefined,
				outputs: [
					{
						lockingScript: locking.toHex(),
						satoshis: 1,
						outputDescription: 'gib commit head',
						basket: GIB_BASKET,
						tags: opts.tags,
						customInstructions: commitHeadCustomInstructions(opts.token.root),
					},
				],
				labels: opts.labels,
				options: { randomizeOutputs: false, signAndProcess: !opts.spend },
			}
			stampManagedOutputIds(args)
			const r = await wallet.createAction(args)
			if (r.txid) return rawTxFromResult(r)
			if (!r.signableTransaction || !opts.spend) {
				throw new Error('unexpected createAction response for commit head')
			}
			const { reference, tx: txBeef } = r.signableTransaction
			try {
				const tx = Transaction.fromBEEF(txBeef)
				const want = opts.spend.outpoint.split('.')[0]
				const idx = tx.inputs.findIndex((i) => (i.sourceTXID ?? '') === want)
				if (idx < 0) throw new Error('token input missing from funded tx')
				const input = tx.inputs[idx]
				const src = input.sourceTransaction?.outputs[input.sourceOutputIndex]
				if (!src) throw new Error('token input source missing')
				const unlock = new PushDrop(wallet).unlock(
					GIB_PROTOCOL,
					opts.spend.keyID,
					'anyone',
					'all',
					false,
					src.satoshis ?? 1,
					src.lockingScript,
				)
				const script = await unlock.sign(tx, idx)
				const signed = await wallet.signAction({
					reference,
					spends: { [idx]: { unlockingScript: script.toHex() } },
					options: { acceptDelayedBroadcast: false },
				})
				if (!signed.txid || !signed.tx) throw new Error('signAction returned no tx')
				const signedTx = Transaction.fromBEEF(Array.from(signed.tx))
				return { txid: signed.txid, bytes: new Uint8Array(signedTx.toBinary()) }
			} catch (e) {
				await wallet.abortAction({ reference }).catch(() => {})
				throw e
			}
		},
		async burnHead(opts) {
			const r = await wallet.createAction({
				description: 'gib burn ref'.slice(0, 50),
				inputBEEF: opts.beef,
				inputs: [
					{
						outpoint: opts.outpoint,
						inputDescription: 'gib commit token burn',
						unlockingScriptLength: 73,
					},
				],
				labels: opts.labels,
				options: { signAndProcess: false },
			})
			if (!r.signableTransaction) throw new Error('burn: expected signable tx')
			const { reference, tx: txBeef } = r.signableTransaction
			try {
				const tx = Transaction.fromBEEF(txBeef)
				const want = opts.outpoint.split('.')[0]
				const idx = tx.inputs.findIndex((i) => (i.sourceTXID ?? '') === want)
				if (idx < 0) throw new Error('burn input missing')
				const input = tx.inputs[idx]
				const src = input.sourceTransaction?.outputs[input.sourceOutputIndex]
				if (!src) throw new Error('burn source missing')
				const unlock = new PushDrop(wallet).unlock(
					GIB_PROTOCOL,
					opts.keyID,
					'anyone',
					'all',
					false,
					src.satoshis ?? 1,
					src.lockingScript,
				)
				const script = await unlock.sign(tx, idx)
				const signed = await wallet.signAction({
					reference,
					spends: { [idx]: { unlockingScript: script.toHex() } },
					options: { acceptDelayedBroadcast: false },
				})
				if (!signed.txid || !signed.tx) throw new Error('signAction returned no tx')
				const signedTx = Transaction.fromBEEF(Array.from(signed.tx))
				return { txid: signed.txid, bytes: new Uint8Array(signedTx.toBinary()) }
			} catch (e) {
				await wallet.abortAction({ reference }).catch(() => {})
				throw e
			}
		},
	}
}

export function headTags(origin: string, branch: string): string[] {
	return [originTag(origin), branchTag(branch)]
}

export { LockingScript }
