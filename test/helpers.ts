import {
	OP,
	P2PKH,
	PrivateKey,
	Script,
	Transaction,
	Utils,
	type WalletInterface,
} from '@bsv/sdk'
import { sealCommitLock } from '../src/seal.ts'
import type { CommitToken } from '../src/token.ts'
import type { TxStore } from '../src/txstore.ts'

export function memStore(seed?: Map<string, Uint8Array>): TxStore {
	const m = seed ?? new Map<string, Uint8Array>()
	return {
		async get(txid) {
			return m.get(txid.toLowerCase())
		},
		async put(txid, bytes) {
			m.set(txid.toLowerCase(), bytes)
		},
	}
}

export function ordScript(contentType: string, body: Uint8Array): Script {
	const s = new Script()
	s.writeOpCode(OP.OP_FALSE)
	s.writeOpCode(OP.OP_IF)
	s.writeBin(Utils.toArray('ord', 'utf8'))
	s.writeOpCode(OP.OP_1)
	s.writeBin(Utils.toArray(contentType, 'utf8'))
	s.writeOpCode(OP.OP_0)
	s.writeBin(Array.from(body))
	s.writeOpCode(OP.OP_ENDIF)
	return s
}

export function bScript(contentType: string, body: Uint8Array): Script {
	const s = new Script()
	s.writeOpCode(OP.OP_FALSE)
	s.writeOpCode(OP.OP_RETURN)
	s.writeBin(Utils.toArray('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut', 'utf8'))
	s.writeBin(Array.from(body))
	s.writeBin(Utils.toArray(contentType, 'utf8'))
	s.writeBin(Utils.toArray('binary', 'utf8'))
	return s
}

export function txWithOutputs(scripts: Script[]): { txid: string; bytes: Uint8Array } {
	const tx = new Transaction()
	const addr = PrivateKey.fromRandom().toPublicKey().toAddress()
	for (const lockingScript of scripts) {
		tx.addOutput({ satoshis: 1, lockingScript: lockingScript as never })
	}
	if (!scripts.length) {
		tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(addr) })
	}
	const bin = tx.toBinary()
	return { txid: tx.id('hex'), bytes: new Uint8Array(bin) }
}

/**
 * A head transaction for tests: a bare PushDrop token, optionally
 * spending the head before it.
 */
export async function headTx(
	wallet: WalletInterface,
	token: CommitToken,
	prev?: Transaction,
): Promise<Transaction> {
	const tx = new Transaction()
	if (prev) {
		tx.addInput({
			sourceTransaction: prev,
			sourceOutputIndex: 0,
			unlockingScript: new Script(),
			sequence: 0xffffffff,
		})
	}
	tx.addOutput({ satoshis: 1, lockingScript: await sealCommitLock(wallet, token) })
	return tx
}
