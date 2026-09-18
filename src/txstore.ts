/**
 * Global transaction store (docs/plans/gib-cli.html):
 *
 *   "every transaction gib has ever seen, stored by txid, verified by
 *   recomputing the txid over parsed bytes. One global store per
 *   install. Nothing is ever refetched or invalidated."
 *
 * Layout: sharded directory store — <root>/<txid[0:2]>/<txid>.bin
 * holding raw signed transaction bytes. Sharded files over SQLite as
 * the medium (a settled-later tunable; files keep zero native deps and
 * are trivially inspectable). If scale ever demands it, the same
 * interface can move to LMDB without callers changing.
 *
 * The txid is Bitcoin's double-SHA256 of the serialized tx, displayed
 * reversed (little-endian) in hex — verified on every write and read,
 * so a corrupt or mismatched blob can never masquerade as a txid.
 */

import {
	access,
	mkdir,
	readFile,
	writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { Transaction } from '@bsv/sdk'

export const TXID_RE = /^[0-9a-f]{64}$/

export class TxstoreError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'TxstoreError'
	}
}

/** Compute the display txid from serialized tx bytes (parse + .id()). */
export function txidOfBytes(raw: Uint8Array | number[]): string {
	return Transaction.fromBinary(raw).id('hex')
}

export class Txstore {
	constructor(readonly root: string) {}

	private shardDir(txid: string): string {
		return join(this.root, txid.slice(0, 2))
	}
	private path(txid: string): string {
		return join(this.shardDir(txid), `${txid}.bin`)
	}

	/**
	 * Store signed transaction bytes under their computed txid.
	 * @param expectedTxid optional guard — mismatch throws.
	 * @returns the txid (canonical, from the bytes themselves).
	 */
	async put(
		raw: Uint8Array | number[],
		expectedTxid?: string,
	): Promise<{ txid: string; isNew: boolean }> {
		if (raw.length === 0) throw new TxstoreError('empty tx bytes')
		const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
		// Parse once to guarantee these are real, serializable tx bytes —
		// and that round-tripping is possible for future BEEF work.
		let tx: Transaction
		try {
			tx = Transaction.fromBinary(bytes)
		} catch (e) {
			throw new TxstoreError(
				`not parseable transaction: ${e instanceof Error ? e.message : 'unknown'}`,
			)
		}
		const txid = txidOfBytes(tx.toBinary())
		if (expectedTxid && txid !== expectedTxid) {
			throw new TxstoreError(
				`txid mismatch: bytes hash to ${txid}, expected ${expectedTxid}`,
			)
		}
		if (await this.has(txid)) return { txid, isNew: false }
		await mkdir(this.shardDir(txid), { recursive: true })
		// no overwrite: the store is immutable by contract. A racing
		// same-txid write is harmless (same hash ⇒ same bytes).
		try {
			await access(this.path(txid))
			return { txid, isNew: false }
		} catch {
			await writeFile(this.path(txid), bytes)
			return { txid, isNew: true }
		}
	}

	/** Fetch raw bytes by txid, re-verifying the hash on read. */
	async get(txid: string): Promise<Uint8Array | undefined> {
		if (!TXID_RE.test(txid)) {
			throw new TxstoreError(`bad txid: ${txid}`)
		}
		let raw: Uint8Array
		try {
			raw = new Uint8Array(await readFile(this.path(txid)))
		} catch {
			return undefined
		}
		const computed = txidOfBytes(raw)
		if (computed !== txid) {
			throw new TxstoreError(
				`store corruption: ${txid} hashes to ${computed}`,
			)
		}
		return raw
	}

	async has(txid: string): Promise<boolean> {
		if (!TXID_RE.test(txid)) return false
		try {
			await access(this.path(txid))
			return true
		} catch {
			return false
		}
	}

	/** Convenience: get + parse. */
	async getTx(txid: string): Promise<Transaction | undefined> {
		const raw = await this.get(txid)
		if (!raw) return undefined
		return Transaction.fromBinary(raw)
	}
}
