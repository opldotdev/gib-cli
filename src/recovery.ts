import type { WalletInterface } from '@bsv/sdk'
import { pushLabel } from './token.ts'
import type { TxStore } from './txstore.ts'

export type PushAction = {
	txid?: string
	status?: string
	reference?: string
}

export type RecoveryPlan =
	| { kind: 'resume'; txid: string }
	| { kind: 'refetch'; txid: string }
	| { kind: 'abort'; reference: string }
	| { kind: 'unknown' }

export async function recoverPush(
	wallet: WalletInterface,
	store: TxStore,
	sha: string,
): Promise<RecoveryPlan[]> {
	if (typeof wallet.listActions !== 'function') return []
	const listed = await wallet.listActions({
		labels: [pushLabel(sha)],
		labelQueryMode: 'any',
	})
	const actions = (listed.actions ?? []) as PushAction[]
	const plans: RecoveryPlan[] = []
	for (const a of actions) {
		if (a.txid) {
			const have = await store.get(a.txid)
			if (have) plans.push({ kind: 'resume', txid: a.txid })
			else plans.push({ kind: 'refetch', txid: a.txid })
			continue
		}
		if (a.reference && (a.status === 'unsigned' || a.status === 'nosend')) {
			plans.push({ kind: 'abort', reference: a.reference })
			continue
		}
		plans.push({ kind: 'unknown' })
	}
	return plans
}
