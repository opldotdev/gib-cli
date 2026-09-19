#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { connectWallet } from './wallet.ts'
import { defaultFetchRawTx, fileTxStore } from './txstore.ts'
import { runHelper } from './remote/helper.ts'

// git invokes `git-remote-gib <remote> <url>` for a named remote and
// `git-remote-gib <url>` for a bare URL.
const url = process.argv[3] ?? process.argv[2]
const remoteName = process.argv[3] ? process.argv[2] : undefined
if (!url) {
	console.error('git-remote-gib: missing remote url')
	process.exit(1)
}

const rl = createInterface({ input: process.stdin, terminal: false })
const iter = rl[Symbol.asyncIterator]()

await runHelper({
	url,
	remoteName,
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
