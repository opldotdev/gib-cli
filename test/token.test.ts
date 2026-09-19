import { describe, expect, it } from 'bun:test'
import { PrivateKey, ProtoWallet, PushDrop } from '@bsv/sdk'
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
		}
		const script = await sealCommitLock(wallet, token)
		const got = decodeCommitToken(script)
		expect(got.origin).toBe(token.origin)
		expect(got.branch).toBe('main')
		expect(got.root).toBe(token.root)
		expect(PushDrop.decode(script).fields.length).toBeGreaterThanOrEqual(5)
	})
})
