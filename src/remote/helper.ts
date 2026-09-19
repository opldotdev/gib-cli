import type { WalletInterface } from '@bsv/sdk'
import { payloadFromScript } from '../content.ts'
import { parseOutpoint } from '../outpoint.ts'
import { loadTx, resolveOutpoint, resolvePath } from '../resolver.ts'
import { collectTree, materializeGit } from '../tree.ts'
import { decodeCommitToken } from '../token.ts'
import { pushLine } from '../push.ts'
import { type Publisher, walletPublisher } from '../publish.ts'
import { advertise, originFromUrl } from './advertise.ts'
import { GIB_FILE, parseRepoMeta } from '../repo-meta.ts'
import { commitParents, importHistory } from './history.ts'
import type { TxStore } from '../txstore.ts'

export type HelperIo = {
	read: () => Promise<string | null>
	write: (s: string) => void
}

export { advertise, originFromUrl }

export async function runHelper(opts: {
	url: string
	/** Remote name git invoked us with; lets a genesis push rewrite its URL. */
	remoteName?: string
	store: TxStore
	wallet?: WalletInterface
	/** Overrides the wallet-backed publisher (tests). */
	publisher?: Publisher
	gitDir: string
	io: HelperIo
	home?: string
	/** Where progress lines go; defaults to stderr, which git relays to the user. */
	log?: (s: string) => void
}): Promise<void> {
	let origin = originFromUrl(opts.url)
	const log = opts.log ?? ((s: string) => process.stderr.write(s))
	for (;;) {
		const line = await opts.io.read()
		if (line === null) return
		const cmd = line.trim()
		if (cmd === 'capabilities') {
			opts.io.write('fetch\npush\n\n')
			continue
		}
		if (cmd === 'list' || cmd === 'list for-push') {
			const refs = opts.wallet
				? await advertise(opts.wallet, opts.store, origin)
				: []
			for (const r of refs) opts.io.write(`${r.sha} ${r.name}\n`)
			const head = await chooseHead(opts.store, refs)
			if (head) opts.io.write(`@${head} HEAD\n`)
			opts.io.write('\n')
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
				await importHistory(opts.store, opts.gitDir, o.outpoint.replace('.', '_'))
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
			const publisher = opts.publisher ?? walletPublisher(opts.wallet)
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
				if (r.ok && isNewOrigin(origin) && r.origin && !isNewOrigin(r.origin)) {
					// Genesis: the repository now has an identity. Later refs in
					// this batch join it, and the remote is repointed so the next
					// push does not mint a second repository.
					origin = r.origin
					const url = `gib://${r.origin}`
					log(`gib: minted repository ${url}\n`)
					if (opts.remoteName) {
						const set = await setRemoteUrl(opts.gitDir, opts.remoteName, url)
						log(
							set
								? `gib: remote '${opts.remoteName}' now points at ${url}\n`
								: `gib: could not update remote '${opts.remoteName}'; run: git remote set-url ${opts.remoteName} ${url}\n`,
						)
					} else {
						log(`gib: add it as a remote: git remote add origin ${url}\n`)
					}
				}
			}
			opts.io.write('\n')
			continue
		}
		if (cmd === '') continue
	}
}

const isNewOrigin = (o: string) => o === '' || o === 'new'

/**
 * The HEAD symref to advertise: `.gib` defaultBranch when a head's tree has
 * one that exists, else main, master, or the first ref. Resolution is
 * best-effort; a missing or malformed `.gib` never breaks `list`.
 */
export async function chooseHead(
	store: TxStore,
	refs: Array<{ name: string; root: string }>,
	readMeta: (store: TxStore, root: string) => Promise<string | undefined> = defaultBranchFromTree,
): Promise<string | undefined> {
	if (refs.length === 0) return undefined
	const names = new Set(refs.map((r) => r.name))
	const preferred = ['refs/heads/main', 'refs/heads/master']
	const first = refs.find((r) => preferred.includes(r.name)) ?? refs[0]
	const wanted = await readMeta(store, first.root)
	if (wanted && names.has(`refs/heads/${wanted}`)) return `refs/heads/${wanted}`
	return preferred.find((p) => names.has(p)) ?? refs[0].name
}

async function defaultBranchFromTree(store: TxStore, root: string): Promise<string | undefined> {
	try {
		const file = await resolvePath(store, parseOutpoint(root), GIB_FILE)
		return parseRepoMeta(new TextDecoder().decode(file.bytes)).defaultBranch
	} catch {
		return undefined
	}
}

async function setRemoteUrl(gitDir: string, remote: string, url: string): Promise<boolean> {
	const proc = Bun.spawn(['git', '--git-dir', gitDir, 'remote', 'set-url', remote, url], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	return (await proc.exited) === 0
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
): Promise<{ commit: string; tree: string; parents: string[] }> {
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
	const r = await materializeGit(gitDir, files, payload.bytes)
	return { ...r, parents: commitParents(payload.bytes) }
}
