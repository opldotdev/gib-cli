import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

export type FetchRawTx = (txid: string) => Promise<Uint8Array | undefined>

export function defaultFetchRawTx(
	baseUrl = process.env.GIB_BEEF_URL ?? 'https://api.1sat.app',
): FetchRawTx {
	return async (txid) => {
		const res = await fetch(`${baseUrl.replace(/\/$/, '')}/1sat/beef/${txid}/tx`)
		if (res.status === 404) return undefined
		if (!res.ok) throw new Error(`beef fetch ${txid}: ${res.status}`)
		return new Uint8Array(await res.arrayBuffer())
	}
}

export function fileTxStore(root?: string, fetchTx?: FetchRawTx): TxStore {
	const base = join(root ?? defaultGibHome(), 'txstore')
	return {
		async get(txid) {
			const id = normalizeTxid(txid)
			try {
				return new Uint8Array(await readFile(shardPath(base, id)))
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
			}
			if (!fetchTx) return undefined
			const remote = await fetchTx(id)
			if (!remote) return undefined
			await putLocal(base, id, remote)
			return remote
		},
		async put(txid, signedBytes) {
			const id = normalizeTxid(txid)
			await putLocal(base, id, signedBytes)
		},
	}
}

async function putLocal(base: string, id: string, signedBytes: Uint8Array): Promise<void> {
	const got = txidOf(signedBytes)
	if (got !== id) {
		throw new Error(`txstore put: bytes hash to ${got}, not ${id}`)
	}
	const path = shardPath(base, id)
	await mkdir(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	await writeFile(tmp, signedBytes)
	await rename(tmp, path)
}

export function txidOf(signedBytes: Uint8Array): string {
	const tx = Transaction.fromBinary(Array.from(signedBytes))
	return tx.id('hex')
}

function shardPath(base: string, txid: string): string {
	return join(base, txid.slice(0, 2), txid.slice(2, 4), txid)
}
