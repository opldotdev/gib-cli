import type { WalletInterface } from '@bsv/sdk'
import { payloadFromScript } from '../content.ts'
import { parseOutpoint } from '../outpoint.ts'
import { loadTx, resolveOutpoint } from '../resolver.ts'
import { collectTree, materializeGit } from '../tree.ts'
import { decodeCommitToken } from '../token.ts'
import { pushLine } from '../push.ts'
import { walletPublisher } from '../publish.ts'
import { advertise, originFromUrl } from './advertise.ts'
import type { TxStore } from '../txstore.ts'

export type HelperIo = {
	read: () => Promise<string | null>
	write: (s: string) => void
}

export { advertise, originFromUrl }

export async function runHelper(opts: {
	url: string
	store: TxStore
	wallet?: WalletInterface
	gitDir: string
	io: HelperIo
	home?: string
}): Promise<void> {
	const origin = originFromUrl(opts.url)
	for (;;) {
		const line = await opts.io.read()
		if (line === null) return
		const cmd = line.trim()
		if (cmd === 'capabilities') {
			opts.io.write('fetch\npush\noption\n\n')
			continue
		}
		if (cmd === 'list' || cmd === 'list for-push') {
			const refs = opts.wallet
				? await advertise(opts.wallet, opts.store, origin)
				: []
			for (const r of refs) opts.io.write(`${r.sha} ${r.name}\n`)
			opts.io.write('\n')
			continue
		}
		if (cmd.startsWith('option ')) {
			opts.io.write('unsupported\n')
			continue
		}
		if (cmd.startsWith('fetch ')) {
			const fetches = [cmd, ...(await readUntilBlank(opts.io))]
			if (!opts.wallet) throw new Error('fetch requires wallet')
			const refs = await advertise(opts.wallet, opts.store, origin)
			for (const f of fetches) {
				const sha = f.split(' ')[1]
				const hit = refs.find((r) => r.sha === sha)
				if (!hit) throw new Error(`unknown sha ${sha}`)
				const listed = await opts.wallet.listOutputs({
					basket: 'gib',
					tags: [
						`origin:${origin}`,
						`branch:${hit.name.replace('refs/heads/', '')}`,
					],
					tagQueryMode: 'all',
					include: 'locking scripts',
					limit: 1,
				})
				const o = listed.outputs?.[0]
				if (!o) throw new Error(`no token for ${hit.name}`)
				await importCommit(opts.store, opts.gitDir, o.outpoint.replace('.', '_'))
			}
			opts.io.write('\n')
			continue
		}
		if (cmd.startsWith('push ')) {
			const pushes = [cmd, ...(await readUntilBlank(opts.io))]
			if (!opts.wallet) {
				for (const p of pushes) {
					const dst = p.slice(p.lastIndexOf(':') + 1)
					opts.io.write(`error ${dst} no wallet\n`)
				}
				opts.io.write('\n')
				continue
			}
			const publisher = walletPublisher(opts.wallet)
			for (const p of pushes) {
				const r = await pushLine({
					line: p,
					gitDir: opts.gitDir,
					store: opts.store,
					wallet: opts.wallet,
					publisher,
					origin,
					home: opts.home,
				})
				if (r.ok) opts.io.write(`ok ${r.dst}\n`)
				else opts.io.write(`error ${r.dst} ${r.error}\n`)
			}
			opts.io.write('\n')
			continue
		}
		if (cmd === '') continue
	}
}

async function readUntilBlank(io: HelperIo): Promise<string[]> {
	const lines: string[] = []
	for (;;) {
		const line = await io.read()
		if (line === null || line.trim() === '') break
		lines.push(line.trim())
	}
	return lines
}

export async function importCommit(
	store: TxStore,
	gitDir: string,
	headOutpoint: string,
): Promise<{ commit: string; tree: string }> {
	const op = parseOutpoint(headOutpoint)
	const tx = await loadTx(store, op.txid)
	const out = tx.outputs[op.vout]
	if (!out) throw new Error(`missing head ${headOutpoint}`)
	const payload = payloadFromScript(out.lockingScript)
	if (!payload) throw new Error('commit head has no inscription')
	const token = decodeCommitToken(out.lockingScript)
	const root = parseOutpoint(token.root)
	await resolveOutpoint(store, root)
	const files = await collectTree(store, root)
	return materializeGit(gitDir, files, payload.bytes)
}
