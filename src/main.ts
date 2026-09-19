#!/usr/bin/env bun
import { createInterface } from 'node:readline/promises'
import { gibInit } from './init.ts'
import { GIB_FILE, type RepoMeta } from './repo-meta.ts'
import { defaultGibHome, fileTxStore, txidOf } from './txstore.ts'
import { connectWallet, walletUrl } from './wallet.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

function flag(name: string): string | undefined {
	const i = argv.indexOf(name)
	return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(name)

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
	process.stdout.write(
		'gib — on-chain git remote\n' +
			'  git-remote-gib is the helper; add/commit/status stay git.\n' +
			'\n' +
			'  gib init [-y] [--name n] [--description d] [--default-branch b] [--remote origin] [--force]\n' +
			`                 write ${GIB_FILE} and add a gib://new remote; first push mints the repo\n` +
			'  gib doctor     check wallet + txstore\n' +
			'  gib put <file> store a signed tx (verifies txid)\n',
	)
	process.exit(0)
}

if (cmd === 'init') {
	const interactive = !has('-y') && !has('--yes') && process.stdin.isTTY === true
	try {
		const r = await gibInit({
			cwd: process.cwd(),
			name: flag('--name'),
			description: flag('--description'),
			defaultBranch: flag('--default-branch'),
			remote: flag('--remote'),
			force: has('--force'),
			prompt: interactive
				? async (d) => {
						const rl = createInterface({ input: process.stdin, output: process.stdout })
						const ask = async (label: string, def?: string) => {
							const a = (await rl.question(def ? `${label} (${def}): ` : `${label}: `)).trim()
							return a || def
						}
						const meta: RepoMeta = {
							name: await ask('name', d.name),
							description: await ask('description', d.description),
							defaultBranch: await ask('default branch', d.defaultBranch),
						}
						rl.close()
						return meta
					}
				: undefined,
		})
		if (r.gitInitialized) process.stdout.write(`initialized git repository in ${r.root}\n`)
		process.stdout.write(`wrote ${r.file}\n`)
		process.stdout.write(
			r.remoteAction === 'added'
				? `remote '${r.remote}' -> ${r.remoteUrl}\n`
				: `remote '${r.remote}' already ${r.remoteUrl}\n`,
		)
		if (r.remoteUrl === 'gib://new') {
			process.stdout.write(
				`next: git add ${GIB_FILE} && git commit && git push ${r.remote} ${r.meta.defaultBranch}\n`,
			)
		}
	} catch (e) {
		console.error(`gib init: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}
	process.exit(0)
}

if (cmd === 'doctor') {
	const home = defaultGibHome()
	process.stdout.write(`GIB_HOME=${home}\n`)
	process.stdout.write(`wallet=${walletUrl()}\n`)
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
	const file = argv[1]
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
