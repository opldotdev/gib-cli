/**
 * `git push` for gib.
 *
 * One head per commit. A push of N commits mints N head tokens, each
 * spending the one before it and each carrying its own commit object and
 * its own root tree; the branch's spend chain is the commit history. The
 * content for all N commits goes out first, in as few transactions as it
 * fits in, and the heads then spend forward through it.
 *
 * Pushing never mints a repository: `gib init` creates one (mintGenesis)
 * and a push joins the repository the remote URL names.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Beef, LockingScript, Transaction, type WalletInterface } from '@bsv/sdk'
import { type Tree, treeFromRoot } from './cascade.ts'
import { type ChainCommit, publishChain } from './chain.ts'
import { payloadFromScript } from './content.ts'
import { gitHash } from './git.ts'
import {
	commitBytes,
	filesAtCommit,
	isAncestor,
	parsePushLine,
	revList,
	revParse,
} from './gitread.ts'
import { formatOutpoint, parseOutpoint } from './outpoint.ts'
import { clearPending, loadPending, savePending } from './pending.ts'
import { headTags, type Publisher, type PublishedTx, type SpendHead } from './publish.ts'
import { recoverPush } from './recovery.ts'
import { previousHead } from './head.ts'
import { atomicWithExtras } from './remote/beef.ts'
import type { Peer } from './remote/peer.ts'
import { loadTx } from './resolver.ts'
import {
	branchTag,
	decodeCommitToken,
	GIB_BASKET,
	gibKeyId,
	LABEL_DELETE,
	LABEL_PUSH,
	NULL_SHA,
	originTag,
} from './token.ts'
import type { TxStore } from './txstore.ts'

export type PushOptions = {
	gitDir: string
	store: TxStore
	wallet: WalletInterface
	publisher: Publisher
	/** Repository origin the remote names. */
	origin: string
	/** The wallet's identity key. */
	identity: string
	/** Peer to submit to, when the remote names one. */
	peer?: Peer
	/** Commit shas already published on this repository, of any branch. */
	have?: string[]
	home?: string
	log?: (s: string) => void
}

export type PushResult =
	| {
			ok: true
			dst: string
			branch: string
			sha: string
			/** Outpoint of the branch's new head ("" for a delete). */
			head: string
			/** Heads minted by this push. */
			minted: number
	  }
	| { ok: false; dst: string; error: string }

/** The branch a destination ref names. Another publisher's is refused. */
export function branchFromRef(dst: string): string {
	const name = dst.replace(/^refs\/heads\//, '')
	if (!name || name === dst) {
		throw new Error(`bad ref ${dst}: gib publishes refs/heads/<branch> only`)
	}
	if (name.startsWith('@')) {
		throw new Error(
			`cannot push ${dst}: that is another publisher's branch; push your own with refs/heads/<branch>`,
		)
	}
	return name
}

export async function pushLine(
	line: string,
	opts: PushOptions,
): Promise<PushResult> {
	const spec = parsePushLine(line)
	let branch: string
	try {
		branch = branchFromRef(spec.dst)
	} catch (e) {
		return { ok: false, dst: spec.dst, error: message(e) }
	}
	try {
		if (!opts.origin) {
			throw new Error(
				'push needs a repository origin: gib://<host>/<repository origin>',
			)
		}
		if (spec.del) return await burnRef(opts, spec.dst, branch)
		const sha = await revParse(opts.gitDir, spec.src)
		const prev = await currentHead(opts, branch)
		if (prev?.sha === sha) {
			// Already published under this identity — a retry, or a push to a
			// second peer. Nothing is built; the peer catches up.
			await syncPeer(opts, branch, prev.outpoint)
			return { ok: true, dst: spec.dst, branch, sha, head: prev.outpoint, minted: 0 }
		}
		if (prev?.sha && !spec.force && !(await isAncestor(opts.gitDir, prev.sha, sha))) {
			return { ok: false, dst: spec.dst, error: 'non-fast-forward' }
		}
		const have = [...(opts.have ?? [])]
		if (prev?.sha) have.push(prev.sha)
		const r = await publishCommits({
			...opts,
			sha,
			branch,
			prev,
			have,
		})
		return { ok: true, dst: spec.dst, branch, sha, head: r.head, minted: r.minted }
	} catch (e) {
		return { ok: false, dst: spec.dst, error: message(e) }
	}
}

export type MintResult = {
	/** Repository origin: newly minted for a genesis. */
	origin: string
	head: string
	sha: string
	minted: number
}

/**
 * `gib init`: mint a repository. The content transaction's root directory
 * becomes the repository origin, and the first head of `branch` is sealed
 * under the wallet's identity. Nothing is published to a peer here.
 */
export async function mintGenesis(
	opts: Omit<PushOptions, 'origin' | 'peer'> & { rev: string; branch: string },
): Promise<MintResult> {
	const sha = await revParse(opts.gitDir, opts.rev)
	return publishCommits({
		...opts,
		origin: '',
		sha,
		branch: opts.branch,
		have: [],
	})
}

async function publishCommits(
	opts: PushOptions & {
		sha: string
		branch: string
		prev?: HeadState
		have: string[]
	},
): Promise<MintResult> {
	const shas = await revList(opts.gitDir, opts.sha, opts.have)
	if (shas.length === 0) {
		throw new Error(`nothing to publish for ${opts.sha}`)
	}
	await abortStaleActions(opts.wallet, opts.sha, opts.log)
	const commits: ChainCommit[] = []
	for (const sha of shas) {
		commits.push({
			sha,
			commit: await commitBytes(opts.gitDir, sha),
			files: await filesAtCommit(opts.gitDir, sha),
		})
	}
	let prevTree: Tree | undefined
	if (opts.prev) {
		prevTree = await treeFromRoot(opts.store, parseOutpoint(opts.prev.root))
	}

	const scratch = await mkdtemp(join(tmpdir(), 'gib-validate-'))
	let content: Awaited<ReturnType<typeof publishChain>>
	try {
		content = await publishChain({
			commits,
			prevTree,
			store: opts.store,
			publisher: opts.publisher,
			labels: [LABEL_PUSH],
			scratchGitDir: scratch,
			pending: await loadPending(opts.sha, opts.home),
			log: opts.log,
		})
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
	await savePending(opts.sha, content.txs, opts.home)

	let origin = opts.origin
	if (!origin) {
		const root = content.roots.get(commits[0].sha)
		if (!root) throw new Error('genesis: no root for the first commit')
		origin = formatOutpoint(root, '_')
	}
	const contentBeef = new Map(content.txs.map((t) => [t.txid, t.beef]))

	let spend = opts.prev?.spend
	let head = opts.prev?.outpoint ?? ''
	let minted = 0
	for (const c of commits) {
		const root = content.roots.get(c.sha)
		if (!root) throw new Error(`no root published for ${c.sha}`)
		const rootStr = formatOutpoint(root, '_')
		const token = {
			origin,
			branch: opts.branch,
			root: rootStr,
			identityPubkey: opts.identity,
		}
		const published = await opts.publisher.publishHead({
			token,
			commitBytes: c.commit,
			sha: c.sha,
			labels: [LABEL_PUSH],
			tags: headTags(origin, opts.branch, c.sha),
			spend,
		})
		await opts.store.put(published.txid, published.bytes)
		head = `${published.txid}_${published.vout}`
		minted++
		spend = {
			outpoint: `${published.txid}.${published.vout}`,
			beef: published.beef,
			keyID: gibKeyId(rootStr),
		}
		await submitHead(opts, published, contentBeef.get(root.txid))
		opts.log?.(`gib: published ${c.sha.slice(0, 12)} as ${head}\n`)
	}
	await clearPending(opts.sha, opts.home)
	return { origin, head, sha: opts.sha, minted }
}

/** Send one head to the peer, with the content its root lives in. */
async function submitHead(
	opts: PushOptions,
	head: PublishedTx,
	contentBeef?: number[],
): Promise<void> {
	if (!opts.peer) return
	const beefs: Array<number[]> = [head.beef]
	if (contentBeef) beefs.push(contentBeef)
	await opts.peer.submit(atomicWithExtras(beefs, head.txid))
}

/**
 * Bring a peer up to date with heads it does not have, without minting.
 * The peer's own copy of the branch says where to start.
 */
async function syncPeer(
	opts: PushOptions,
	branch: string,
	tip: string,
): Promise<void> {
	if (!opts.peer) return
	const seen = new Set<string>()
	let since = ''
	for (;;) {
		const page = await opts.peer.headsSince({
			origin: opts.origin,
			branch,
			identity: opts.identity,
			since,
		})
		for (const h of page.heads) seen.add(h.outpoint)
		if (!page.more || page.heads.length === 0) break
		since = page.heads[page.heads.length - 1].outpoint
	}
	// Walk our own chain back from the tip to the first head the peer has.
	const missing: string[] = []
	let cursor: string | undefined = tip
	while (cursor && !seen.has(cursor)) {
		missing.push(cursor)
		cursor = await previousHead(opts.store, cursor).catch(() => undefined)
	}
	for (const outpoint of missing.reverse()) {
		const { txid } = parseOutpoint(outpoint)
		const bytes = await opts.store.get(txid)
		if (!bytes) throw new Error(`sync: ${txid} is not in the local store`)
		const tx = await loadTx(opts.store, txid)
		const token = decodeCommitToken(tx.outputs[parseOutpoint(outpoint).vout].lockingScript)
		const beefs: Array<number[] | Uint8Array> = [rawBeef(bytes)]
		const rootTxid = parseOutpoint(token.root).txid
		const rootBytes =
			rootTxid === txid ? undefined : await opts.store.get(rootTxid)
		if (rootBytes) beefs.push(rawBeef(rootBytes))
		await opts.peer.submit(atomicWithExtras(beefs, txid))
	}
}

/** A single raw transaction as a one-transaction BEEF. */
function rawBeef(bytes: Uint8Array): number[] {
	const beef = new Beef()
	beef.mergeTransaction(Transaction.fromBinary(Array.from(bytes)))
	return beef.toBinary()
}

type HeadState = {
	outpoint: string
	root: string
	sha: string
	spend: SpendHead
}

/**
 * The head to spend for (repository origin, branch) under this wallet's
 * identity. The wallet's own unspent basket output is what decides
 * spendability; the commit it publishes is read off its inscription.
 */
async function currentHead(
	opts: PushOptions,
	branch: string,
): Promise<HeadState | undefined> {
	const listed = await opts.wallet.listOutputs({
		basket: GIB_BASKET,
		tags: [originTag(opts.origin), branchTag(branch)],
		tagQueryMode: 'all',
		include: 'entire transactions',
		includeTags: true,
		includeCustomInstructions: true,
		limit: 1,
	})
	const o = listed.outputs?.[0]
	if (!o?.lockingScript) return undefined
	const token = decodeCommitToken(o.lockingScript)
	if (token.identityPubkey !== opts.identity) {
		throw new Error(
			`head ${o.outpoint} belongs to identity ${token.identityPubkey}`,
		)
	}
	if (!o.customInstructions) {
		throw new Error('commit token missing customInstructions')
	}
	const ci = JSON.parse(o.customInstructions) as { keyID?: string }
	if (!ci.keyID) throw new Error('customInstructions missing keyID')
	if (!listed.BEEF?.length) {
		throw new Error(`wallet returned no BEEF for ${o.outpoint}`)
	}
	const payload = payloadFromScript(LockingScript.fromHex(o.lockingScript))
	if (!payload) throw new Error('commit head has no inscription')
	const outpoint = o.outpoint.replace('.', '_')
	return {
		outpoint,
		root: token.root,
		sha: gitHash('commit', payload.bytes),
		spend: {
			outpoint: o.outpoint,
			beef: Array.from(listed.BEEF),
			keyID: ci.keyID,
		},
	}
}

async function burnRef(
	opts: PushOptions,
	dst: string,
	branch: string,
): Promise<PushResult> {
	const prev = await currentHead(opts, branch)
	if (!prev) return { ok: false, dst, error: 'no such ref' }
	const burn = await opts.publisher.burnHead({
		...prev.spend,
		labels: [LABEL_DELETE],
	})
	await opts.store.put(burn.txid, burn.bytes)
	if (opts.peer) {
		await opts.peer.submit(atomicWithExtras([burn.beef], burn.txid))
	}
	return { ok: true, dst, branch, sha: NULL_SHA, head: '', minted: 1 }
}

/** Abort unsigned wallet actions an interrupted push of this sha left. */
async function abortStaleActions(
	wallet: WalletInterface,
	sha: string,
	log?: (s: string) => void,
): Promise<void> {
	let plans: Awaited<ReturnType<typeof recoverPush>>
	try {
		plans = await recoverPush(wallet, sha)
	} catch {
		return // best effort: wallets without listActions still push
	}
	for (const p of plans) {
		if (p.kind !== 'abort') continue
		log?.('gib: aborting a stale wallet action from an interrupted push\n')
		await wallet.abortAction({ reference: p.reference }).catch(() => {})
	}
}

function message(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e)
	return text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
}
