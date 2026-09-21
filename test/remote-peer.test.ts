import { afterAll, describe, expect, it } from 'bun:test'
import {
	Beef,
	PrivateKey,
	ProtoWallet,
	Script,
	Transaction,
	type WalletInterface,
} from '@bsv/sdk'
import { MAX_TXIDS, Peer, SyncBrokenError, peerFor } from '../src/remote/peer.ts'
import { parseGibUrl } from '../src/remote/url.ts'
import { clearDiscoveryCache } from '../src/remote/discover.ts'
import { headTx } from './helpers.ts'
import { startFakePeer } from './fakes/peer.ts'

const wallet = new ProtoWallet(new PrivateKey(4242)) as unknown as WalletInterface
const identity = 'ab'.repeat(33)
const origin = `${'a'.repeat(64)}_0`

/** One head token spending `prev`, as a transaction the peer can index. */
const head = (branch: string, root: string, prev?: Transaction) =>
	headTx(
		wallet,
		{ origin, branch, root, identityPubkey: identity, branchedFrom: '' },
		prev,
	)

const atomic = (tx: Transaction) =>
	new Uint8Array(tx.toAtomicBEEF(true))

const peers: Array<{ stop: () => void }> = []
afterAll(() => {
	for (const p of peers) p.stop()
})

describe('peer lookup client', () => {
	it('walks a branch with headsSince, oldest first, and pages', async () => {
		const fake = startFakePeer()
		peers.push(fake)
		const peer = new Peer({ submit: '', lookup: '' })
		const real = new Peer({
			submit: `${fake.url}/1sat/gib/overlay`,
			lookup: `${fake.url}/1sat/gib/overlay`,
		})
		expect(peer.endpoints.lookup).toBe('')

		const a = await head('main', `${'c'.repeat(64)}_0`)
		const b = await head('main', `${'c'.repeat(64)}_1`, a)
		const other = await head('dev', `${'c'.repeat(64)}_2`)
		for (const tx of [a, b, other]) await real.submit(atomic(tx))

		const all = await real.headsSince({ origin, branch: 'main' })
		expect(all.more).toBe(false)
		expect(all.heads.map((h) => h.outpoint)).toEqual([
			`${a.id('hex')}_0`,
			`${b.id('hex')}_0`,
		])
		expect(all.heads[0].vout).toBe(0)
		// Each head carries its own BEEF, and it parses.
		const beef = Beef.fromBinary(Array.from(all.heads[1].beef))
		expect(beef.findTxid(b.id('hex'))).toBeTruthy()

		const page = await real.headsSince({ origin, branch: 'main', limit: 1 })
		expect(page.more).toBe(true)
		expect(page.heads).toHaveLength(1)

		const rest = await real.headsSince({
			origin,
			branch: 'main',
			since: page.heads[0].outpoint,
		})
		expect(rest.heads.map((h) => h.outpoint)).toEqual([`${b.id('hex')}_0`])
		expect(rest.more).toBe(false)

		// A branch the peer has nothing for is empty, not an error.
		expect(
			(await real.headsSince({ origin, branch: 'nope' })).heads,
		).toHaveLength(0)

		// Filtering by identity keeps only that publisher's heads.
		expect(
			(await real.headsSince({ origin, branch: 'main', identity })).heads,
		).toHaveLength(2)
		expect(
			(
				await real.headsSince({
					origin,
					branch: 'main',
					identity: `02${'0'.repeat(64)}`,
				})
			).heads,
		).toHaveLength(0)
	})

	it('reports a since the peer does not know as a broken sync', async () => {
		const fake = startFakePeer()
		peers.push(fake)
		const real = new Peer({
			submit: `${fake.url}/1sat/gib/overlay`,
			lookup: `${fake.url}/1sat/gib/overlay`,
		})
		await real.submit(atomic(await head('main', `${'c'.repeat(64)}_0`)))
		const err = await real
			.headsSince({ origin, branch: 'main', since: `${'d'.repeat(64)}_0` })
			.catch((e) => e)
		expect(err).toBeInstanceOf(SyncBrokenError)
		expect((err as SyncBrokenError).code).toBe('unknown-since')
	})

	it('fetches whole transactions as one merged BEEF, absent ones simply missing', async () => {
		const fake = startFakePeer()
		peers.push(fake)
		const real = new Peer({
			submit: `${fake.url}/1sat/gib/overlay`,
			lookup: `${fake.url}/1sat/gib/overlay`,
		})
		const a = await head('main', `${'c'.repeat(64)}_0`)
		const b = await head('main', `${'c'.repeat(64)}_1`, a)
		for (const tx of [a, b]) await real.submit(atomic(tx))

		const missing = 'f'.repeat(64)
		const bytes = await real.txs([a.id('hex'), missing, b.id('hex')])
		const beef = Beef.fromBinary(Array.from(bytes))
		expect(beef.findTxid(a.id('hex'))).toBeTruthy()
		expect(beef.findTxid(b.id('hex'))).toBeTruthy()
		expect(beef.findTxid(missing)).toBeUndefined()

		expect(await real.txs([])).toHaveLength(0)
		expect(real.txs(new Array(MAX_TXIDS + 1).fill(missing))).rejects.toThrow(
			/at most 50/,
		)
	})

	it('resolves its endpoints from the peer manifest', async () => {
		const fake = startFakePeer()
		peers.push(fake)
		clearDiscoveryCache()
		const peer = await peerFor(parseGibUrl(`gib://${fake.host}/${origin}`))
		expect(peer?.endpoints.lookup).toBe(`${fake.url}/1sat/gib/overlay`)
		expect(await peerFor(parseGibUrl(`gib://${origin}`))).toBeUndefined()
		clearDiscoveryCache()
	})
})
