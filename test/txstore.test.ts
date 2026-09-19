import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileTxStore, txidOf } from '../src/txstore.ts'
import { txWithOutputs } from './helpers.ts'

describe('txstore', () => {
	it('put verifies txid and get round-trips', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'gib-tx-'))
		try {
			const store = fileTxStore(dir)
			const { txid, bytes } = txWithOutputs([])
			expect(txidOf(bytes)).toBe(txid)
			await store.put(txid, bytes)
			expect(await store.get(txid)).toEqual(bytes)
			expect(await store.get('aa'.repeat(32))).toBeUndefined()
			await expect(store.put('bb'.repeat(32), bytes)).rejects.toThrow(/hash to/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
