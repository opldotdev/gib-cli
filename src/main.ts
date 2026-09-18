#!/usr/bin/env bun
import { defaultGibHome, fileTxStore, txidOf } from './txstore.ts'
import { connectWallet, DEFAULT_WALLET_URL } from './wallet.ts'

const cmd = process.argv[2] ?? 'help'

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
	process.stdout.write(
		'gib — on-chain git remote\n' +
			'  git remote add origin gib://<origin-outpoint>\n' +
			'  git-remote-gib is the helper; add/commit/status stay git.\n' +
			'\n' +
			'  gib doctor     check wallet + txstore\n' +
			'  gib put <file> store a signed tx (verifies txid)\n',
	)
	process.exit(0)
}

if (cmd === 'doctor') {
	const home = defaultGibHome()
	process.stdout.write(`GIB_HOME=${home}\n`)
	process.stdout.write(`wallet=${DEFAULT_WALLET_URL}\n`)
	try {
		const w = connectWallet()
		await w.getPublicKey({ identityKey: true })
		process.stdout.write('wallet: ok\n')
	} catch (e) {
		process.stdout.write(`wallet: ${e instanceof Error ? e.message : e}\n`)
	}
	process.exit(0)
}

if (cmd === 'put') {
	const file = process.argv[3]
	if (!file) {
		console.error('usage: gib put <signed-tx>')
		process.exit(1)
	}
	const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
	const txid = txidOf(bytes)
	await fileTxStore().put(txid, bytes)
	process.stdout.write(`${txid}\n`)
	process.exit(0)
}

console.error(`unknown command: ${cmd}`)
process.exit(1)
