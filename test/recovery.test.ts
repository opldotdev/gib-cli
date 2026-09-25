import { describe, expect, it } from 'bun:test'
import type { WalletInterface } from '@bsv/sdk'
import { recoverPush } from '../src/recovery.ts'
import { txWithOutputs } from './helpers.ts'

describe('recovery', () => {
	it('reports an action that already published a transaction', async () => {
		const { txid } = txWithOutputs([])
		const wallet = {
			async listActions() {
				return { actions: [{ txid, status: 'completed', description: 'gib content deadbeef' }] }
			},
		} as unknown as WalletInterface
		expect(await recoverPush(wallet, 'deadbeef')).toEqual([
			{ kind: 'published', txid },
		])
	})

	it('abort unsigned by reference', async () => {
		const wallet = {
			async listActions() {
				return { actions: [{ reference: 'abc', status: 'unsigned', description: 'gib head deadbeef' }] }
			},
		} as unknown as WalletInterface
		expect(await recoverPush(wallet, 'deadbeef')).toEqual([
			{ kind: 'abort', reference: 'abc' },
		])
	})
})
