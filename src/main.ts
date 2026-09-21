#!/usr/bin/env bun
import { createInterface } from 'node:readline/promises'
import { DEFAULT_PEER_HOST, gibInit } from './init.ts'
import { loadIdentity } from './identity.ts'
import { loadRepoState, saveRepoState } from './refs.ts'
import { GIB_FILE, type RepoMeta } from './repo-meta.ts'
import { peerFor } from './remote/peer.ts'
import { parseGibUrl } from './remote/url.ts'
import { pullRepo } from './remote/sync.ts'
import { peerFetchRawTx } from './remote/store.ts'
import { defaultGibHome, fileTxStore, txidOf } from './txstore.ts'
import { connectWallet, walletUrl } from './wallet.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

function flag(name: string): string | undefined {
	const i = argv.indexOf(name)
	return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(name)
const home = defaultGibHome()

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
	process.stdout.write(
		'gib — on-chain git\n' +
			'  git-remote-gib is the helper; add/commit/status stay git.\n' +
			'\n' +
			'  gib init [-y] [--name n] [--description d] [--remote local] [--host gibhub.net]\n' +
			`                    mint the repository from HEAD, write ${GIB_FILE}, add the local remote\n` +
			'  gib sync <remote> [branch...]\n' +
			'                    refresh a repository from its peer; naming a branch\n' +
			'                    teaches this client a branch it could not discover\n' +
			'  gib doctor         check wallet + txstore\n' +
			'  gib put <file>     store a signed tx (verifies txid)\n',
	)
	process.exit(0)
}

if (cmd === 'init') {
	const interactive = !has('-y') && !has('--yes') && process.stdin.isTTY === true
	try {
		const wallet = connectWallet()
		const r = await gibInit({
			cwd: process.cwd(),
			wallet,
			store: fileTxStore(home),
			home,
			name: flag('--name'),
			description: flag('--description'),
			remote: flag('--remote'),
			host: flag('--host') ?? DEFAULT_PEER_HOST,
			log: (s) => process.stderr.write(s),
			prompt: interactive
				? async (d) => {
						const rl = createInterface({
							input: process.stdin,
							output: process.stdout,
						})
						const ask = async (label: string, def?: string) => {
							const a = (
								await rl.question(def ? `${label} (${def}): ` : `${label}: `)
							).trim()
							return a || def
						}
						const meta: RepoMeta = {
							name: await ask('name', d.name),
							description: await ask('description', d.description),
							defaultBranch: d.defaultBranch,
						}
						rl.close()
						return meta
					}
				: undefined,
		})
		if (r.wroteMeta) process.stdout.write(`wrote ${r.file}\n`)
		if (r.created) {
			process.stdout.write(
				`minted repository origin ${r.origin}\n  branch ${r.branch} at ${r.sha}\n  identity ${r.identity}\n`,
			)
		} else {
			process.stdout.write(
				`repository origin ${r.origin} already publishes this repository\n`,
			)
		}
		process.stdout.write(
			r.remoteAction === 'added'
				? `remote '${r.remote}' -> ${r.remoteUrl} (local only)\n`
				: `remote '${r.remote}' -> ${r.remoteUrl}\n`,
		)
		process.stdout.write(
			`publish through a peer:\n  git remote add gib ${r.peerUrl}\n  git push gib ${r.branch}\n`,
		)
	} catch (e) {
		console.error(`gib init: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}
	process.exit(0)
}

if (cmd === 'sync') {
	const url = argv[1]
	if (!url) {
		console.error(
			'usage: gib sync gib://<host>/<repository origin> [branch...]',
		)
		process.exit(1)
	}
	// Naming branches is how a client learns of one it cannot discover:
	// the lookup service has no query that enumerates them.
	const branches = argv.slice(2).filter((a) => !a.startsWith('-'))
	try {
		const parsed = parseGibUrl(url)
		const peer = await peerFor(parsed)
		if (!peer) throw new Error('that URL names no peer to sync with')
		const store = fileTxStore(home, peerFetchRawTx(peer))
		const state = await loadRepoState(parsed.origin, home)
		const added = await pullRepo(peer, store, state, branches)
		await saveRepoState(state, home)
		for (const w of state.warnings) process.stderr.write(`gib: ${w}\n`)
		process.stdout.write(`${added} new head(s)\n`)
		for (const r of Object.values(state.refs)) {
			process.stdout.write(`${r.sha} ${r.identity.slice(0, 8)}… ${r.branch}\n`)
		}
	} catch (e) {
		console.error(`gib sync: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}
	process.exit(0)
}

if (cmd === 'doctor') {
	process.stdout.write(`GIB_HOME=${home}\n`)
	process.stdout.write(`wallet=${walletUrl()}\n`)
	const cached = await loadIdentity(home)
	process.stdout.write(`identity=${cached || '(not cached)'}\n`)
	try {
		const w = connectWallet()
		const { publicKey } = await w.getPublicKey({ identityKey: true })
		process.stdout.write(`wallet: ok (${publicKey})\n`)
	} catch (e) {
		process.stdout.write(`wallet: ${e instanceof Error ? e.message : e}\n`)
	}
	process.exit(0)
}

if (cmd === 'put') {
	const file = argv[1]
	if (!file) {
		console.error('usage: gib put <signed-tx>')
		process.exit(1)
	}
	const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
	const txid = txidOf(bytes)
	await fileTxStore(home).put(txid, bytes)
	process.stdout.write(`${txid}\n`)
	process.exit(0)
}

console.error(`unknown command: ${cmd}`)
process.exit(1)
