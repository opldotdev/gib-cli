import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultGibHome } from './txstore.ts'

export type PendingTx = { phase: 'content' | 'head'; txid: string; bytes: Uint8Array }

function dir(sha: string, home?: string): string {
	return join(home ?? defaultGibHome(), 'pending', sha)
}

export async function savePending(sha: string, txs: PendingTx[], home?: string): Promise<void> {
	const d = dir(sha, home)
	await mkdir(d, { recursive: true })
	const recs = txs.map((t) => ({
		phase: t.phase,
		txid: t.txid,
		hex: Buffer.from(t.bytes).toString('hex'),
	}))
	await writeFile(join(d, 'txs.json'), JSON.stringify(recs))
}

export async function loadPending(sha: string, home?: string): Promise<PendingTx[] | undefined> {
	try {
		const raw = JSON.parse(await readFile(join(dir(sha, home), 'txs.json'), 'utf8')) as Array<{
			phase: 'content' | 'head'
			txid: string
			hex: string
		}>
		return raw.map((t) => ({
			phase: t.phase,
			txid: t.txid,
			bytes: new Uint8Array(Buffer.from(t.hex, 'hex')),
		}))
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw e
	}
}

export async function clearPending(sha: string, home?: string): Promise<void> {
	await rm(dir(sha, home), { recursive: true, force: true })
}

export async function listPending(home?: string): Promise<string[]> {
	try {
		return await readdir(join(home ?? defaultGibHome(), 'pending'))
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw e
	}
}
