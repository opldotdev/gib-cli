#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { connectWallet } from './wallet.ts'
import { defaultFetchRawTx, fileTxStore } from './txstore.ts'
import { runHelper } from './remote/helper.ts'

const url = process.argv[3] ?? process.argv[2]
if (!url) {
	console.error('git-remote-gib: missing remote url')
	process.exit(1)
}

const rl = createInterface({ input: process.stdin, terminal: false })
const iter = rl[Symbol.asyncIterator]()

await runHelper({
	url,
	store: fileTxStore(undefined, defaultFetchRawTx()),
	wallet: connectWallet(),
	gitDir: process.env.GIT_DIR ?? '.git',
	io: {
		async read() {
			const n = await iter.next()
			return n.done ? null : String(n.value)
		},
		write(s) {
			process.stdout.write(s)
		},
	},
})
