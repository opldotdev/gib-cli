import { describe, expect, it } from 'bun:test'
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import { commitParents } from '../src/fetch.ts'
import { previousHead } from '../src/head.ts'
import { headTx, memStore } from './helpers.ts'

const origin = `${'a'.repeat(64)}_0`
const commit = (parent?: string) =>
	new TextEncoder().encode(
		`tree ${'b'.repeat(40)}\n${parent ? `parent ${parent}\n` : ''}author A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nmsg\n`,
	)

describe('head chains', () => {
	it('parses parents from a commit object', () => {
		expect(commitParents(commit())).toEqual([])
		expect(commitParents(commit('c'.repeat(40)))).toEqual(['c'.repeat(40)])
	})

	it('finds the head a head spent, and none for the first', async () => {
		const wallet = new ProtoWallet(new PrivateKey(4242)) as unknown as WalletInterface
		const store = memStore()
		const token = (root: string) => ({
			origin,
			branch: 'main',
			root,
			identityPubkey: 'ab'.repeat(33),
			branchedFrom: '',
		})
		const first = await headTx(wallet, token(origin))
		await store.put(first.id('hex'), new Uint8Array(first.toBinary()))
		const second = await headTx(wallet, token(`${'d'.repeat(64)}_3`), first)
		await store.put(second.id('hex'), new Uint8Array(second.toBinary()))

		expect(await previousHead(store, `${second.id('hex')}_0`)).toBe(
			`${first.id('hex')}_0`,
		)
		expect(await previousHead(store, `${first.id('hex')}_0`)).toBeUndefined()
	})
})
