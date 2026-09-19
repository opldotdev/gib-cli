import { describe, expect, it } from 'bun:test'
import type { WalletInterface } from '@bsv/sdk'
import { recoverPush } from '../src/recovery.ts'
import { memStore } from './helpers.ts'
import { txWithOutputs } from './helpers.ts'

describe('recovery', () => {
	it('resume when txstore has the signed bytes', async () => {
		const { txid, bytes } = txWithOutputs([])
		const store = memStore()
		await store.put(txid, bytes)
		const wallet = {
			async listActions() {
				return { actions: [{ txid, status: 'completed', description: 'gib content deadbeef' }] }
			},
		} as unknown as WalletInterface
		expect(await recoverPush(wallet, store, 'deadbeef')).toEqual([
			{ kind: 'resume', txid },
		])
	})

	it('abort unsigned by reference', async () => {
		const store = memStore()
		const wallet = {
			async listActions() {
				return { actions: [{ reference: 'abc', status: 'unsigned', description: 'gib head deadbeef' }] }
			},
		} as unknown as WalletInterface
		expect(await recoverPush(wallet, store, 'deadbeef')).toEqual([
			{ kind: 'abort', reference: 'abc' },
		])
	})
})
