/**
 * Chain fetch: get transaction bytes for a txid, by any means, and
 * land them in the txstore. The txstore is write-once, so repeated
 * resolution of the same outpoint across pushes/clones is free.
 *
 * Order (per docs/plans/gib-cli.html): txstore first (zero network),
 * then api.1sat.app BEEF (full provenable tx), then arcade (rawTx,
 * works pre-chaintrack / in mempool). Foreign data never passes
 * through the wallet.
 */

import type { Txstore } from './txstore'

const API_BASE = 'https://api.1sat.app/1sat'
const ARCADE_BASE = 'https://arcade.1sat.app'

export class FetchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'FetchError'
	}
}

export interface Fetcher {
	/** Raw signed tx bytes for a txid (txstore-cached forever). */
	txBytes(txid: string): Promise<Uint8Array>
}

export function createFetcher(
	store: Txstore,
	fetchImpl: typeof fetch = fetch,
): Fetcher {
	async function networkBytes(txid: string): Promise<Uint8Array> {
		// 1) BEEF endpoint — canonical full transaction with proofs.
		const beefRes = await fetchImpl(`${API_BASE}/beef/${txid}/tx`)
		if (beefRes.ok) {
			const buf = new Uint8Array(await beefRes.arrayBuffer())
			// /beef/{txid}/tx serves the raw tx (not the BEEF wrapper).
			if (buf.length > 0) return buf
		}
		// 2) Arcade — includes rawTx; resolves mempool txs immediately.
		const arcRes = await fetchImpl(`${ARCADE_BASE}/tx/${txid}`)
		if (arcRes.ok) {
			const body = (await arcRes.json()) as { rawTx?: string }
			if (body.rawTx) return fromHex(body.rawTx)
		}
		throw new FetchError(`tx ${txid} not found on beef endpoint or arcade`)
	}

	return {
		async txBytes(txid: string): Promise<Uint8Array> {
			const cached = await store.get(txid)
			if (cached) return cached
			const raw = await networkBytes(txid)
			// put() verifies the hash against txid — a lying source is
			// rejected loudly rather than poisoning the store.
			await store.put(raw, txid)
			return raw
		},
	}
}

export function fromHex(hex: string): Uint8Array {
	if (!/^([0-9a-fA-F]{2})*$/.test(hex)) {
		throw new FetchError('bad hex from source')
	}
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}
