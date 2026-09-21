#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { peerFetchRawTx } from './remote/store.ts'
import { peerFor } from './remote/peer.ts'
import { parseGibUrl } from './remote/url.ts'
import { runHelper } from './remote/helper.ts'
import { localBranches } from './gitread.ts'
import { defaultGibHome, fileTxStore } from './txstore.ts'
import { connectWallet } from './wallet.ts'

// git invokes `git-remote-gib <remote> <url>` for a named remote and
// `git-remote-gib <url>` for a bare URL.
const url = process.argv[3] ?? process.argv[2]
if (!url) {
	console.error('git-remote-gib: missing remote url')
	process.exit(1)
}

const gitDir = process.env.GIT_DIR ?? '.git'
const home = defaultGibHome()

try {
	const peer = await peerFor(parseGibUrl(url))
	const rl = createInterface({ input: process.stdin, terminal: false })
	const iter = rl[Symbol.asyncIterator]()
	await runHelper({
		url,
		store: fileTxStore(home, peerFetchRawTx(peer)),
		peer,
		wallet: async () => connectWallet(),
		gitDir,
		home,
		localBranches: await localBranches(gitDir),
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
} catch (e) {
	console.error(`git-remote-gib: ${e instanceof Error ? e.message : e}`)
	process.exit(1)
}
