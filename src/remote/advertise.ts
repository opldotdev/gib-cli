import type { WalletInterface } from '@bsv/sdk'
import { payloadFromScript } from '../content.ts'
import { gitHash } from '../git.ts'
import { parseOutpoint } from '../outpoint.ts'
import { loadTx } from '../resolver.ts'
import {
	branchTag,
	decodeCommitToken,
	GIB_BASKET,
	originTag,
} from '../token.ts'
import type { TxStore } from '../txstore.ts'

export function originFromUrl(url: string): string {
	return url.replace(/^gib:\/\//, '').replace(/\/$/, '')
}

export async function advertise(
	wallet: WalletInterface,
	store: TxStore,
	origin: string,
): Promise<Array<{ sha: string; name: string }>> {
	if (!origin || origin === 'new') return []
	const listed = await wallet.listOutputs({
		basket: GIB_BASKET,
		tags: [originTag(origin)],
		tagQueryMode: 'all',
		include: 'locking scripts',
		includeTags: true,
		limit: 10000,
	})
	const refs: Array<{ sha: string; name: string }> = []
	for (const o of listed.outputs ?? []) {
		if (!o.lockingScript) continue
		let token: ReturnType<typeof decodeCommitToken>
		try {
			token = decodeCommitToken(o.lockingScript)
		} catch {
			continue
		}
		if (token.origin !== origin) continue
		const tags = o.tags ?? []
		if (!tags.includes(branchTag(token.branch))) continue
		const op = parseOutpoint(o.outpoint.replace('.', '_'))
		const sha = await commitShaFromHead(store, op)
		refs.push({ sha, name: `refs/heads/${token.branch}` })
	}
	return refs
}

async function commitShaFromHead(
	store: TxStore,
	op: ReturnType<typeof parseOutpoint>,
): Promise<string> {
	const tx = await loadTx(store, op.txid)
	const out = tx.outputs[op.vout]
	if (!out) throw new Error(`missing commit head ${op.txid}_${op.vout}`)
	const payload = payloadFromScript(out.lockingScript)
	if (!payload) throw new Error('commit head has no inscription')
	return gitHash('commit', payload.bytes)
}
