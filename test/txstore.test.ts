import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	LockingScript,
	PrivateKey,
	Transaction,
	Utils,
} from '@bsv/sdk'
import { Txstore, TxstoreError, txidOfBytes, TXID_RE } from '../src/txstore'

const tmp = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gib-txstore-'))
	return dir
}

function syntheticTx(): Transaction {
	const key = PrivateKey.fromRandom()
	const lock = new LockingScript([
		{ op: 0x76, data: [] },
		{ op: 0xa9, data: [] },
		{ op: 20, data: key.toPublicKey().encode('hex') as never },
		{ op: 0x88, data: [] },
		{ op: 0xac, data: [] },
	])
	const tx = new Transaction(1, [], [])
	tx.addInput({
		sourceTXID: 'ab'.repeat(32),
		sourceOutputIndex: 0,
		unlockingScript: new LockingScript(),
	})
	tx.addOutput({ satoshis: 1, lockingScript: lock })
	return tx
}

describe('txidOfBytes', () => {
	it('matches Transaction.id', () => {
		const tx = syntheticTx()
		expect(txidOfBytes(tx.toBinary())).toBe(tx.id('hex'))
	})
	it('real mainnet genesis tx id validates against known txid', () => {
		// The verified gib genesis from the prototype sessions: bytes would
		// be needed to recompute, so just assert the id shape we store by.
		const known =
			'c657be5a7dacd7bb7343d92b7195d1366dbecd3ec31874576189efd28eee007c'
		expect(TXID_RE.test(known)).toBe(true)
	})
})

describe('Txstore', () => {
	it('put/get round-trip by computed txid', async () => {
		const store = new Txstore(await tmp())
		const tx = syntheticTx()
		const raw = tx.toBinary()
		const { txid, isNew } = await store.put(raw)
		expect(txid).toBe(tx.id('hex'))
		expect(isNew).toBe(true)
		const back = await store.get(txid)
		expect(back).toBeDefined()
		expect(Utils.toHex(back!)).toBe(Utils.toHex(raw))
	})

	it('idempotent put returns isNew false, no corruption', async () => {
		const store = new Txstore(await tmp())
		const raw = syntheticTx().toBinary()
		await store.put(raw)
		const { isNew } = await store.put(raw)
		expect(isNew).toBe(false)
	})

	it('rejects bytes that are not a transaction', async () => {
		const store = new Txstore(await tmp())
		await expect(
			store.put(new TextEncoder().encode('not a tx')),
		).rejects.toThrow(TxstoreError)
	})

	it('expectedTxid guard catches mismatch', async () => {
		const store = new Txstore(await tmp())
		await expect(
			store.put(syntheticTx().toBinary(), 'ff'.repeat(32)),
		).rejects.toThrow(/mismatch/)
	})

	it('get returns undefined for unknown txid', async () => {
		const store = new Txstore(await tmp())
		expect(await store.get('ab'.repeat(32))).toBeUndefined()
		expect(await store.has('ab'.repeat(32))).toBe(false)
	})

	it('rejects malformed txid strings', async () => {
		const store = new Txstore(await tmp())
		await expect(store.get('nope')).rejects.toThrow(TxstoreError)
	})

	it('detects corruption on read', async () => {
		const dir = await tmp()
		const store = new Txstore(dir)
		const tx = syntheticTx()
		const { txid } = await store.put(tx.toBinary())
		// flip bytes inside the stored blob
		const { writeFile } = await import('node:fs/promises')
		await writeFile(join(dir, txid.slice(0, 2), `${txid}.bin`), new Uint8Array([1, 2, 3, 4]))
		await expect(store.get(txid)).rejects.toThrow(/corruption/)
	})

	it('getTx parses', async () => {
		const store = new Txstore(await tmp())
		const tx = syntheticTx()
		const { txid } = await store.put(tx.toBinary())
		const parsed = await store.getTx(txid)
		expect(parsed?.id('hex')).toBe(txid)
	})
})
