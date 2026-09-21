/**
 * `gib init` — create a repository on chain.
 *
 * This is where a repository is born: the commit HEAD points at is
 * published, and the root of its tree becomes the repository origin, the
 * outpoint that names the repository for ever after. Only the wallet and
 * the local store are involved; no peer hears about it until a push.
 *
 * A push never mints a repository, so there is exactly one way to create
 * one and no way to create a second by accident.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { WalletInterface } from '@bsv/sdk'
import { saveIdentity } from './identity.ts'
import { mintGenesis } from './push.ts'
import { type Publisher, walletPublisher } from './publish.ts'
import { formatRepoMeta, GIB_FILE, parseRepoMeta, type RepoMeta } from './repo-meta.ts'
import { emptyRepoState, loadRepoState, recordHead, saveRepoState } from './refs.ts'
import { readHead } from './head.ts'
import { parseGibUrl } from './remote/url.ts'
import type { TxStore } from './txstore.ts'

/** The host `gib init` suggests publishing through. */
export const DEFAULT_PEER_HOST = 'gibhub.net'

export type InitOptions = {
	cwd: string
	wallet: WalletInterface
	store: TxStore
	publisher?: Publisher
	home?: string
	name?: string
	description?: string
	/** Name of the local-only remote to add; defaults to `local`. */
	remote?: string
	/** Peer host to suggest for publishing. */
	host?: string
	/** Called with computed defaults when interactive. */
	prompt?: (defaults: RepoMeta) => Promise<RepoMeta>
	log?: (s: string) => void
}

export type InitResult = {
	root: string
	file: string
	meta: RepoMeta
	/** Repository origin: the genesis root outpoint. */
	origin: string
	branch: string
	sha: string
	head: string
	identity: string
	/** False when the repository already had a gib remote. */
	created: boolean
	remote: string
	remoteUrl: string
	remoteAction: 'added' | 'unchanged'
	/** The remote to add to publish through a peer. */
	peerUrl: string
	wroteMeta: boolean
}

async function git(
	cwd: string,
	args: string[],
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { code, out: out.trim(), err: err.trim() }
}

/** Current branch name, or `main` when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string> {
	const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
	return r.code === 0 && r.out ? r.out : 'main'
}

/** The repository origin an existing gib:// remote already names, if any. */
async function existingOrigin(root: string): Promise<{ remote: string; origin: string } | undefined> {
	const r = await git(root, ['remote', '-v'])
	if (r.code !== 0) return undefined
	for (const line of r.out.split('\n')) {
		const [name, url] = line.split(/\s+/)
		if (!url?.startsWith('gib://')) continue
		try {
			return { remote: name, origin: parseGibUrl(url).origin }
		} catch {
			// a malformed gib remote is not an existing repository
		}
	}
	return undefined
}

export async function gibInit(opts: InitOptions): Promise<InitResult> {
	const top = await git(opts.cwd, ['rev-parse', '--show-toplevel'])
	if (top.code !== 0) {
		throw new Error('not a git repository: run `git init`, commit, then `gib init`')
	}
	const root = resolve(top.out)
	const gitDirOut = await git(root, ['rev-parse', '--absolute-git-dir'])
	if (gitDirOut.code !== 0) throw new Error(`git dir: ${gitDirOut.err}`)
	const gitDir = gitDirOut.out
	if ((await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).code !== 0) {
		throw new Error('gib init needs at least one commit')
	}
	const remote = opts.remote ?? 'local'
	const host = opts.host ?? DEFAULT_PEER_HOST
	const branch = await currentBranch(root)

	// `.gib` is written when missing and left alone otherwise. defaultBranch
	// is kept because it is the only hint a clone has about which branch to
	// ask a peer for: no lookup enumerates a repository's branches.
	const file = join(root, GIB_FILE)
	let meta: RepoMeta
	let wroteMeta = false
	if (existsSync(file)) {
		meta = parseRepoMeta(await readFile(file, 'utf8'))
	} else {
		const defaults: RepoMeta = {
			name: opts.name ?? basename(root),
			description: opts.description,
			defaultBranch: branch,
		}
		const chosen = opts.prompt ? await opts.prompt(defaults) : defaults
		meta = {
			name: (chosen.name ?? defaults.name)?.trim() || defaults.name,
			description: chosen.description?.trim() || undefined,
			defaultBranch:
				(chosen.defaultBranch ?? defaults.defaultBranch)?.trim() || branch,
		}
		parseRepoMeta(formatRepoMeta(meta))
		await writeFile(file, formatRepoMeta(meta))
		wroteMeta = true
	}

	const { publicKey: identity } = await opts.wallet.getPublicKey({
		identityKey: true,
	})
	await saveIdentity(identity, opts.home).catch(() => {})

	const already = await existingOrigin(root)
	if (already) {
		const state = await loadRepoState(already.origin, opts.home)
		const ref = Object.values(state.refs).find((r) => r.identity === identity)
		return {
			root,
			file,
			meta,
			origin: already.origin,
			branch: state.genesis?.branch ?? branch,
			sha: ref?.sha ?? '',
			head: ref?.head ?? '',
			identity,
			created: false,
			remote: already.remote,
			remoteUrl: `gib://${already.origin}`,
			remoteAction: 'unchanged',
			peerUrl: `gib://${host}/${already.origin}`,
			wroteMeta,
		}
	}

	if ((await git(root, ['cat-file', '-e', `HEAD:${GIB_FILE}`])).code !== 0) {
		opts.log?.(
			`note: ${GIB_FILE} is not committed; the genesis tree will not carry it (commit it and push to publish it)\n`,
		)
	}

	const minted = await mintGenesis({
		gitDir,
		store: opts.store,
		wallet: opts.wallet,
		publisher: opts.publisher ?? walletPublisher(opts.wallet),
		identity,
		home: opts.home,
		rev: 'HEAD',
		branch,
		log: opts.log,
	})

	const state = emptyRepoState(minted.origin)
	const head = await readHead(opts.store, minted.head)
	recordHead(state, {
		identity,
		branch,
		head: minted.head,
		sha: minted.sha,
		root: head.token.root,
	})
	await saveRepoState(state, opts.home)

	const localUrl = `gib://${minted.origin}`
	const existing = await git(root, ['remote', 'get-url', remote])
	let remoteAction: InitResult['remoteAction'] = 'unchanged'
	if (existing.code !== 0) {
		const add = await git(root, ['remote', 'add', remote, localUrl])
		if (add.code !== 0) throw new Error(`git remote add ${remote}: ${add.err}`)
		remoteAction = 'added'
	}
	return {
		root,
		file,
		meta,
		origin: minted.origin,
		branch,
		sha: minted.sha,
		head: minted.head,
		identity,
		created: true,
		remote,
		remoteUrl: existing.code === 0 ? existing.out : localUrl,
		remoteAction,
		peerUrl: `gib://${host}/${minted.origin}`,
		wroteMeta,
	}
}
