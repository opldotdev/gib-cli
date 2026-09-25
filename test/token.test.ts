import { describe, expect, it } from 'bun:test'
import { pushDropLock } from '@1sat/actions'
import {
	PrivateKey,
	ProtoWallet,
	PushDrop,
	Utils,
	type WalletInterface,
} from '@bsv/sdk'
import { sealCommitLock } from '../src/seal.ts'
import { decodeCommitToken } from '../src/token.ts'

describe('commit token', () => {
	it('seals and decodes fields', async () => {
		const wallet = new ProtoWallet(new PrivateKey(9001))
		const { publicKey } = await wallet.getPublicKey({ identityKey: true })
		const token = {
			origin: `${'ab'.repeat(32)}_0`,
			branch: 'main',
			root: `${'cd'.repeat(32)}_1`,
			identityPubkey: publicKey,
			branchedFrom: '',
		}
		const script = await sealCommitLock(wallet, token)
		const got = decodeCommitToken(script)
		expect(got.origin).toBe(token.origin)
		expect(got.branch).toBe('main')
		expect(got.root).toBe(token.root)
		expect(got.identityPubkey).toBe(publicKey)
		// Six fields and the signature: no more, and nothing inscribed.
		expect(PushDrop.decode(script).fields.length).toBe(7)
	})

	it('carries the head a branch forked from, and reads absence back', async () => {
		const wallet = new ProtoWallet(new PrivateKey(9001))
		const { publicKey } = await wallet.getPublicKey({ identityKey: true })
		const base = {
			origin: `${'ab'.repeat(32)}_0`,
			branch: 'feature',
			root: `${'cd'.repeat(32)}_1`,
			identityPubkey: publicKey,
		}
		const from = `${'ef'.repeat(32)}_2`
		expect(
			decodeCommitToken(
				await sealCommitLock(wallet, { ...base, branchedFrom: from }),
			).branchedFrom,
		).toBe(from)
		// An absent field is an empty push, which PushDrop encodes as
		// OP_FALSE — the same opcode a single zero byte encodes to, so both
		// read back as absent.
		expect(
			decodeCommitToken(await sealCommitLock(wallet, { ...base, branchedFrom: '' }))
				.branchedFrom,
		).toBe('')
	})

	it('refuses the five-field heads gib published before this', async () => {
		const wallet = new ProtoWallet(new PrivateKey(9001)) as unknown as WalletInterface
		const old = await pushDropLock(
			wallet,
			{
				fields: [
					Utils.toArray('gib', 'utf8'),
					Utils.toArray(`${'ab'.repeat(32)}_0`, 'utf8'),
					Utils.toArray('main', 'utf8'),
					Utils.toArray(`${'cd'.repeat(32)}_1`, 'utf8'),
					Utils.toArray('02'.repeat(33), 'utf8'),
				],
				protocolID: [1, 'gib branch'],
				keyID: 'k',
				counterparty: 'anyone',
				forSelf: true,
			},
			{ includeSignature: true },
		)
		expect(() => decodeCommitToken(old)).toThrow(/not a gib commit head/)
	})
})
