import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Transaction } from '@bsv/sdk'
import { normalizeTxid } from './outpoint.ts'

export type TxStore = {
	get(txid: string): Promise<Uint8Array | undefined>
	put(txid: string, signedBytes: Uint8Array): Promise<void>
}

export function defaultGibHome(): string {
	return process.env.GIB_HOME ?? join(homedir(), '.gib')
}

export function fileTxStore(root?: string): TxStore {
	const base = join(root ?? defaultGibHome(), 'txstore')
	return {
		async get(txid) {
			const id = normalizeTxid(txid)
			try {
				return new Uint8Array(await readFile(shardPath(base, id)))
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
				throw e
			}
		},
		async put(txid, signedBytes) {
			const id = normalizeTxid(txid)
			const got = txidOf(signedBytes)
			if (got !== id) {
				throw new Error(`txstore put: bytes hash to ${got}, not ${id}`)
			}
			const path = shardPath(base, id)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, signedBytes)
		},
	}
}

export function txidOf(signedBytes: Uint8Array): string {
	const tx = Transaction.fromBinary(Array.from(signedBytes))
	return tx.id('hex')
}

function shardPath(base: string, txid: string): string {
	return join(base, txid.slice(0, 2), txid.slice(2, 4), txid)
}
