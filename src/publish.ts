import {
	completeSignedAction,
	stampManagedOutputIds,
	unlockByScript,
} from '@1sat/actions'
import {
	type CreateActionArgs,
	type CreateActionResult,
	Transaction,
	type WalletInterface,
} from '@bsv/sdk'
import type { CommitPlan } from './cascade.ts'
import { GIT_COMMIT_TYPE, appendOrdEnvelope, bLockingScript, isProvablyUnspendable } from './script.ts'
import { commitHeadCustomInstructions, sealCommitLock } from './seal.ts'
import {
	GIB_BASKET,
	GIB_PROTOCOL,
	branchTag,
	originTag,
	type CommitToken,
} from './token.ts'

export type PublishedTx = { txid: string; bytes: Uint8Array }

export type SpendHead = {
	outpoint: string
	beef: number[]
	keyID: string
}

export type Publisher = {
	publishContent(plan: CommitPlan, labels: string[]): Promise<PublishedTx>
	publishHead(opts: {
		token: CommitToken
		commitBytes: Uint8Array
		labels: string[]
		tags: string[]
		spend?: SpendHead
	}): Promise<PublishedTx>
	burnHead(opts: SpendHead & { labels: string[] }): Promise<PublishedTx>
}

function rawTxFromResult(r: CreateActionResult): PublishedTx {
	if (!r.txid) throw new Error('createAction returned no txid')
	if (!r.tx?.length) throw new Error('createAction returned no tx bytes')
	const tx = Transaction.fromBEEF(Array.from(r.tx))
	return { txid: r.txid, bytes: new Uint8Array(tx.toBinary()) }
}

async function unlockPushDrop(
	wallet: WalletInterface,
	keyID: string,
	outpoint: string,
	beef: number[],
	createResult: CreateActionResult,
): Promise<PublishedTx> {
	const done = await completeSignedAction(
		wallet,
		createResult,
		beef,
		async (tx) => {
			const want = outpoint.split('.')[0]
			const idx = tx.inputs.findIndex((i) => (i.sourceTXID ?? '') === want)
			if (idx < 0) throw new Error('token input missing from funded tx')
			const input = tx.inputs[idx]
			const src = input.sourceTransaction?.outputs[input.sourceOutputIndex]
			if (!src) throw new Error('token input source missing')
			const r = await unlockByScript(
				wallet,
				tx,
				idx,
				src.lockingScript,
				src.satoshis ?? 1,
				{ protocolID: GIB_PROTOCOL, keyID, counterparty: 'anyone' },
			)
			if ('error' in r) throw new Error(`unlock head: ${r.error}`)
			return { [idx]: { unlockingScript: r.unlockingScript } }
		},
		{ acceptDelayedBroadcast: false },
	)
	if (done.error || !done.txid || !done.tx) {
		throw new Error(done.error ?? 'signAction returned no tx')
	}
	const signedTx = Transaction.fromBEEF(Array.from(done.tx))
	return { txid: done.txid, bytes: new Uint8Array(signedTx.toBinary()) }
}

/**
 * Wallet substrates (HTTPWalletJSON) throw the whole request in the error
 * text, which for a content push is the entire tree as hex; git's packet
 * line then truncates the message before the reason. Keep call + message.
 */
async function walletCall<T>(what: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e)
		if (text.startsWith('{')) {
			try {
				const j = JSON.parse(text) as { call?: string; message?: string }
				if (j.message) throw new Error(`wallet ${j.call ?? what}: ${j.message}`)
			} catch (inner) {
				if (inner instanceof Error && inner.message.startsWith('wallet ')) throw inner
			}
		}
		throw new Error(`wallet ${what}: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`)
	}
}

export function walletPublisher(wallet: WalletInterface): Publisher {
	return {
		async publishContent(plan, labels) {
			const outputs = plan.outputs.map((o, i) => {
				const script = bLockingScript(o.contentType, o.bytes)
				if (!isProvablyUnspendable(script)) {
					throw new Error(`refusing to publish a zero-sat output miners would treat as dust: ${o.path ?? i}`)
				}
				return {
					lockingScript: script.toHex(),
				satoshis: 0,
				// BRC-100 wallets require 5-50 chars here; paths like "/" are shorter.
				outputDescription: `gib ${o.path ?? `content ${i}`}`.slice(0, 50),
							}
			})
			const r = await walletCall('createAction (content)', () =>
				wallet.createAction({
					description: `gib content ${labels[0] ?? ''}`.slice(0, 50),
					outputs,
					labels,
					// signAndProcess defaults to true; setting it explicitly is admin-only in some wallets.
					options: { randomizeOutputs: false },
				}),
			)
			return rawTxFromResult(r)
		},
		async publishHead(opts) {
			if (opts.spend && !opts.spend.keyID) {
				throw new Error('spend missing customInstructions keyID')
			}
			const pd = await sealCommitLock(wallet, opts.token)
			const locking = appendOrdEnvelope(pd, GIT_COMMIT_TYPE, opts.commitBytes)
			const args: CreateActionArgs = {
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
				options: opts.spend
					? { randomizeOutputs: false, signAndProcess: false }
					: { randomizeOutputs: false },
			}
			stampManagedOutputIds(args)
			const r = await walletCall('createAction (head)', () => wallet.createAction(args))
			if (r.txid) return rawTxFromResult(r)
			if (!opts.spend) throw new Error('unexpected createAction response for commit head')
			return unlockPushDrop(
				wallet,
				opts.spend.keyID,
				opts.spend.outpoint,
				opts.spend.beef,
				r,
			)
		},
		async burnHead(opts) {
			const r = await walletCall('createAction (burn)', () =>
				wallet.createAction({
				description: 'gib burn ref',
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
				}),
			)
			return unlockPushDrop(wallet, opts.keyID, opts.outpoint, opts.beef, r)
		},
	}
}

export function headTags(origin: string, branch: string): string[] {
	return [originTag(origin), branchTag(branch)]
}
