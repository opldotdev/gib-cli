import type { FetchRawTx } from '../txstore.ts'
import { Beef } from '@bsv/sdk'
import type { Peer } from './peer.ts'

/**
 * The store's last resort when something asks for a transaction nobody
 * prefetched: one `txs` question for that transaction alone. The batched
 * path in sync.ts is what should normally fill the store; this keeps a
 * stray read from failing.
 */
export function peerFetchRawTx(peer?: Peer): FetchRawTx | undefined {
	if (!peer) return undefined
	return async (txid: string) => {
		try {
			const bytes = await peer.txs([txid])
			if (bytes.length === 0) return undefined
			const beef = Beef.fromBinary(Array.from(bytes))
			const tx = beef.findTxid(txid)?.tx
			return tx ? new Uint8Array(tx.toBinary()) : undefined
		} catch {
			return undefined
		}
	}
}
