export type Outpoint = {
	txid: string
	vout: number
}

const TXID = /^[0-9a-f]{64}$/

export function parseOutpoint(s: string): Outpoint {
	const u = s.indexOf('_')
	const d = u < 0 ? s.indexOf('.') : u
	if (d !== 64) throw new Error(`bad outpoint: ${s}`)
	const txid = s.slice(0, 64).toLowerCase()
	const vout = Number(s.slice(d + 1))
	if (!TXID.test(txid) || !Number.isInteger(vout) || vout < 0) {
		throw new Error(`bad outpoint: ${s}`)
	}
	return { txid, vout }
}

export function formatOutpoint(op: Outpoint, sep: '_' | '.' = '_'): string {
	return `${op.txid.toLowerCase()}${sep}${op.vout}`
}

export function normalizeTxid(txid: string): string {
	const t = txid.toLowerCase()
	if (!TXID.test(t)) throw new Error(`bad txid: ${txid}`)
	return t
}
