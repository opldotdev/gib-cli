import { describe, expect, it } from 'bun:test'
import { PrivateKey, ProtoWallet, Script, Transaction, type WalletInterface } from '@bsv/sdk'
import { commitParents, previousHead } from '../src/remote/history.ts'
import { GIT_COMMIT_TYPE, appendOrdEnvelope } from '../src/script.ts'
import { sealCommitLock } from '../src/seal.ts'
import { memStore } from './helpers.ts'

const origin = `${'a'.repeat(64)}_0`
const commit = (parent?: string) =>
	new TextEncoder().encode(
		`tree ${'b'.repeat(40)}\n${parent ? `parent ${parent}\n` : ''}author A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nmsg\n`,
	)

describe('fetch history', () => {
	it('parses parents from a commit object', () => {
		expect(commitParents(commit())).toEqual([])
		expect(commitParents(commit('c'.repeat(40)))).toEqual(['c'.repeat(40)])
	})

	it('finds the head a head spent, and none for genesis', async () => {
		const wallet = new ProtoWallet(new PrivateKey(4242)) as unknown as WalletInterface
		const store = memStore()
		const lock = async (root: string) =>
			appendOrdEnvelope(
				await sealCommitLock(wallet, { origin, branch: 'main', root, identityPubkey: 'ab' }),
				GIT_COMMIT_TYPE,
				commit(),
			)
		const genesis = new Transaction()
		genesis.addOutput({ satoshis: 1, lockingScript: await lock(origin) })
		await store.put(genesis.id('hex'), new Uint8Array(genesis.toBinary()))

		const push = new Transaction()
		push.addInput({
			sourceTXID: genesis.id('hex'),
			sourceOutputIndex: 0,
			unlockingScript: new Script(),
			sequence: 0xffffffff,
		})
		push.addOutput({ satoshis: 1, lockingScript: await lock(`${'d'.repeat(64)}_3`) })
		await store.put(push.id('hex'), new Uint8Array(push.toBinary()))

		expect(await previousHead(store, `${push.id('hex')}_0`)).toBe(`${genesis.id('hex')}_0`)
		expect(await previousHead(store, `${genesis.id('hex')}_0`)).toBeUndefined()
	})
})
