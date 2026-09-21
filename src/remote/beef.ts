import { Beef, Utils } from '@bsv/sdk'

const ATOMIC_BEEF = 0x01010101

/**
 * Atomic BEEF naming `txid`, carrying everything in `beefs` — including
 * transactions that are not the subject's ancestors.
 *
 * `Beef.toBinaryAtomic` prunes to the subject's dependency closure, which
 * would drop the content transaction a head's root lives in: the head
 * spends the previous head, not the content. The overlay needs both in one
 * submission, so the atomic header is written by hand over the merged BEEF.
 */
export function atomicWithExtras(
	beefs: Array<number[] | Uint8Array>,
	txid: string,
): Uint8Array {
	const merged = new Beef()
	for (const b of beefs) merged.mergeBeef(Array.from(b))
	if (!merged.findTxid(txid)) {
		throw new Error(`bundle: ${txid} is not in the merged BEEF`)
	}
	const body = merged.toBinary()
	const out = new Uint8Array(4 + 32 + body.length)
	new DataView(out.buffer).setUint32(0, ATOMIC_BEEF, true)
	const idBytes = Utils.toArray(txid, 'hex')
	for (let i = 0; i < 32; i++) out[4 + i] = idBytes[31 - i]
	out.set(body, 36)
	return out
}
