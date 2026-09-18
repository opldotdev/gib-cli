import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction } from '@bsv/sdk'
import { createFetcher } from '../src/fetch'
import { Txstore } from '../src/txstore'

// Verified gib genesis tx from prototype sessions (mainnet, mined).
const GENESIS_TXID =
	'c657be5a7dacd7bb7343d92b7195d1366dbecd3ec31874576189efd28eee007c'

describe('fetcher (live network)', () => {
	it('fetches a real mined tx, verifies its txid, caches it', async () => {
		const store = new Txstore(await mkdtemp(join(tmpdir(), 'gib-fetch-')))
		const f = createFetcher(store)
		const raw = await f.txBytes(GENESIS_TXID)
		// verification already happened inside put(expectedTxid) —
		// reaching here means the bytes hash to the requested txid.
		const tx = Transaction.fromBinary(raw)
		expect(tx.id('hex')).toBe(GENESIS_TXID)
		// cached now: a fetcher with an offline impl still resolves it
		const offline = createFetcher(
			store,
			(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
		)
		expect(await offline.txBytes(GENESIS_TXID)).toBeDefined()
	}, 30000)

	it('unknown txid fails clearly', async () => {
		const store = new Txstore(await mkdtemp(join(tmpdir(), 'gib-fetch-')))
		const f = createFetcher(store)
		await expect(
			f.txBytes('de'.repeat(32)),
		).rejects.toThrow(/not found/)
	}, 30000)
})
