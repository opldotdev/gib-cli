/**
 * `git push` for gib.
 *
 * One head per push. A push mints a single head token, spending the
 * branch's previous head, pointing at one published root: git's tree for
 * the tip commit, plus a `.git` store holding every commit object
 * reachable from that tip and every one of those commits' trees. Commits
 * are hash-linked, so a signature over the tip commits to every ancestor —
 * a head per commit bought nothing and cost a transaction each.
 *
 * Because the store is keyed by sha, a commit or a tree that is already on
 * chain is cited at the outpoint that holds it. Branching from someone
 * else's head therefore copies nothing: their objects are already
 * published, and this push's `.git` points at them.
 *
 * Pushing never mints a repository: `gib init` creates one (mintGenesis)
 * and a push joins the repository the remote URL names.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Beef, LockingScript, Transaction, type WalletInterface } from '@bsv/sdk'
import {
	loadPublishedRoot,
	type Plan,
	type PlanEntry,
	type PlanRef,
	planCommit,
	type Tree,
} from './cascade.ts'
import { Plan as PlanBuilder } from './cascade.ts'
import { packContent } from './chain.ts'
import { commitParents, importRoot } from './fetch.ts'
import { previousHead, tipSha } from './head.ts'
import {
	commitBytes,
	commitTreePairs,
	filesAtCommit,
	isAncestor,
	parsePushLine,
	revParse,
} from './gitread.ts'
import { formatOutpoint, type Outpoint, parseOutpoint } from './outpoint.ts'
import { clearPending, loadPending, savePending } from './pending.ts'
import { dryPublish, overlayStore } from './preview.ts'
import {
	headTags,
	type Publisher,
	type PublishedTx,
	type SpendHead,
} from './publish.ts'
import { recoverPush } from './recovery.ts'
import { atomicWithExtras } from './remote/beef.ts'
import { MAX_PAGES, type Peer } from './remote/peer.ts'
import { GIT_COMMIT_TYPE } from './script.ts'
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
import { collectTxids, GIT_DIR } from './tree.ts'
import type { TxStore } from './txstore.ts'

/** A head this client already knows about, for finding what to branch from. */
export type KnownHead = {
	outpoint: string
	/** Commit it publishes, when this client has read it. */
	sha: string
	identity: string
	branch: string
	root?: string
}

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
	/** Heads this client knows of, to branch from and to merge in. */
	knownHeads?: KnownHead[]
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
			/** True when this push minted a head. */
			minted: boolean
			/** The head this one branched from or merged in, if any. */
			branchedFrom: string
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
		const known = opts.knownHeads?.find(
			(h) => h.identity === opts.identity && h.branch === branch,
		)
		if (!prev && known) {
			// Minting here would start a second chain for this branch under
			// the same identity, with nothing spending the existing head:
			// two tips, no ancestry, and no way for a reader to tell which
			// is the branch. The wallet has to be repaired first.
			throw new Error(
				`the wallet holds no spendable head for ${branch}, but ${known.outpoint} is its current head: pushing now would start a second chain`,
			)
		}
		if (prev?.sha === sha) {
			// Already published under this identity — a retry, or a push to
			// a second peer. Nothing is built; the peer catches up.
			await syncPeer(opts, branch, prev.outpoint)
			return {
				ok: true,
				dst: spec.dst,
				branch,
				sha,
				head: prev.outpoint,
				minted: false,
				branchedFrom: '',
			}
		}
		if (prev?.sha && !spec.force && !(await isAncestor(opts.gitDir, prev.sha, sha))) {
			return { ok: false, dst: spec.dst, error: 'non-fast-forward' }
		}
		const r = await publishPush({ ...opts, sha, branch, prev })
		return {
			ok: true,
			dst: spec.dst,
			branch,
			sha,
			head: r.head,
			minted: true,
			branchedFrom: r.branchedFrom,
		}
	} catch (e) {
		return { ok: false, dst: spec.dst, error: message(e) }
	}
}

export type MintResult = {
	/** Repository origin: newly minted for a genesis. */
	origin: string
	head: string
	sha: string
	branchedFrom: string
}

/**
 * `gib init`: mint a repository. The published root of this first push
 * becomes the repository origin, and its head is the repository's genesis
 * head. Nothing is published to a peer here.
 */
export async function mintGenesis(
	opts: Omit<PushOptions, 'origin' | 'peer'> & { rev: string; branch: string },
): Promise<MintResult> {
	const sha = await revParse(opts.gitDir, opts.rev)
	return publishPush({ ...opts, origin: '', sha, branch: opts.branch })
}

type PushState = PushOptions & {
	sha: string
	branch: string
	prev?: HeadState
}

async function publishPush(opts: PushState): Promise<MintResult> {
	await abortStaleActions(opts.wallet, opts.sha, opts.log)

	// What this push continues from: our own head on this branch, or — for
	// a branch's first push — the head it forks from.
	const fork = opts.prev ? undefined : await pickFork(opts)
	const baseRoot = opts.prev ? parseOutpoint(opts.prev.root) : fork?.root
	const base = baseRoot ? await loadPublishedRoot(opts.store, baseRoot) : undefined

	const tip = await commitBytes(opts.gitDir, opts.sha)
	const reachable = await commitTreePairs(opts.gitDir, opts.sha)
	if (reachable.length === 0 || reachable[reachable.length - 1].sha !== opts.sha) {
		throw new Error(`nothing to publish for ${opts.sha}`)
	}

	const plan = new PlanBuilder()
	// `.git` is an object store: a name is a sha, so a name is proof of
	// content. Anything already on chain is cited, never republished.
	const objects = new Map<string, PlanEntry>()
	const cite = (name: string, isDir: boolean): boolean => {
		const known = base?.objects.get(name)
		if (!known) return false
		objects.set(name, { name, isDir, ref: known.ref })
		return true
	}

	let tree: Tree | undefined = base?.tree
	let tipRootId: number | undefined
	let tipCommitRef: PlanRef | undefined
	let published = 0
	for (const { sha, tree: treeSha } of reachable) {
		const isTip = sha === opts.sha
		if (!cite(sha, false)) {
			const bytes = isTip ? tip : await commitBytes(opts.gitDir, sha)
			const id = plan.add({
				kind: 'data',
				contentType: GIT_COMMIT_TYPE,
				bytes,
				label: `commit ${sha.slice(0, 12)}`,
			})
			objects.set(sha, { name: sha, isDir: false, ref: { kind: 'node', id } })
		}
		if (isTip) tipCommitRef = objects.get(sha)?.ref

		// A commit's tree is published once, under its own sha: two commits
		// with the same tree share it, and an ancestor already on chain is
		// cited whole.
		const haveTree = objects.has(treeSha) || cite(treeSha, true)
		if (!haveTree || isTip) {
			const commitPlan = await planCommit({
				files: await filesAtCommit(opts.gitDir, sha),
				prev: tree,
				plan,
			})
			tree = commitPlan.tree
			published++
			if (!haveTree) {
				objects.set(treeSha, {
					name: treeSha,
					isDir: true,
					ref: { kind: 'node', id: commitPlan.rootId },
				})
			}
			if (isTip) tipRootId = commitPlan.rootId
		}
	}
	if (tipRootId === undefined || !tipCommitRef) {
		throw new Error('push: the tip commit was not planned')
	}
	// The default entry is how a reader finds which commit a head
	// publishes without reading every object in the store.
	objects.set('.', { name: '.', isDir: false, ref: tipCommitRef })

	const gitStoreId = plan.add({
		kind: 'dir',
		entries: [...objects.values()],
		label: GIT_DIR,
	})
	const tipRoot = plan.nodes[tipRootId]
	if (tipRoot.kind !== 'dir') throw new Error('push: tip root is not a directory')
	const rootId = plan.add({
		kind: 'dir',
		entries: [
			...tipRoot.entries,
			{ name: GIT_DIR, isDir: true, ref: { kind: 'node', id: gitStoreId } },
		],
		label: '/',
	})

	await dryRun(opts, plan, rootId)

	const packed = await packContent({
		plan,
		store: opts.store,
		publish: (outputs) =>
			opts.publisher.publishContent(outputs, [LABEL_PUSH], opts.sha),
		pending: await loadPending(opts.sha, opts.home),
		onContent: (txs) => savePending(opts.sha, txs, opts.home),
		log: opts.log,
	})
	const root = packed.outpoints.get(rootId)
	if (!root) throw new Error('push: the root was not published')
	const rootStr = formatOutpoint(root, '_')
	const origin = opts.origin || rootStr
	opts.log?.(
		`gib: published ${published} tree(s) and ${reachable.length} commit(s) in ${packed.txs.length} transaction(s)\n`,
	)

	// The peer may not have the chain this push continues — a repository
	// minted by `gib init`, or a peer added later. Send what it lacks
	// first, so the head minted below never arrives over a gap.
	if (opts.prev) await syncPeer(opts, opts.branch, opts.prev.outpoint)

	const branchedFrom = fork?.outpoint ?? (await mergedFrom(opts, tip))
	const head = await opts.publisher.publishHead({
		token: {
			origin,
			branch: opts.branch,
			root: rootStr,
			identityPubkey: opts.identity,
			branchedFrom,
		},
		sha: opts.sha,
		labels: [LABEL_PUSH],
		tags: headTags(origin, opts.branch, opts.sha),
		spend: opts.prev?.spend,
	})
	await opts.store.put(head.txid, head.bytes)
	await clearPending(opts.sha, opts.home)
	const outpoint = `${head.txid}_${head.vout}`
	await submitHead(opts, head, packed.txs)
	return { origin, head: outpoint, sha: opts.sha, branchedFrom }
}

/**
 * Publish the plan into a throwaway store and read it back with the
 * reader a clone would use: every tree must materialise to the sha its
 * commit names, `.git` stripped. Nothing is spent until this passes.
 */
async function dryRun(
	opts: PushState,
	plan: Plan,
	rootId: number,
): Promise<void> {
	const scratchStore = overlayStore(opts.store)
	const packed = await packContent({
		plan,
		store: scratchStore,
		publish: dryPublish,
	})
	const root = packed.outpoints.get(rootId)
	if (!root) throw new Error('push: the root was not planned')
	const gitDir = await mkdtemp(join(tmpdir(), 'gib-validate-'))
	try {
		const imported = await importRoot(scratchStore, gitDir, root)
		if (imported.tip !== opts.sha) {
			throw new Error(
				`validation: the published root publishes ${imported.tip}, not ${opts.sha}`,
			)
		}
	} finally {
		await rm(gitDir, { recursive: true, force: true })
	}
}

/** Send the head and this push's content to the peer. */
async function submitHead(
	opts: PushOptions,
	head: PublishedTx,
	content: PublishedTx[],
): Promise<void> {
	if (!opts.peer) return
	const beefs: Array<number[] | Uint8Array> = [head.beef]
	for (const tx of content) beefs.push(tx.beef.length ? tx.beef : rawBeef(tx.bytes))
	await opts.peer.submit(atomicWithExtras(beefs, head.txid))
}

/**
 * The head a new branch forks from: the newest head this client knows
 * whose commit is an ancestor of what is being pushed. Its published root
 * is what the new branch's first push cites, so forking copies nothing.
 */
async function pickFork(
	opts: PushState,
): Promise<{ outpoint: string; root: Outpoint } | undefined> {
	const candidates: KnownHead[] = []
	for (const h of opts.knownHeads ?? []) {
		if (!h.sha || !h.outpoint) continue
		if (h.sha === opts.sha || (await isAncestorQuiet(opts.gitDir, h.sha, opts.sha))) {
			candidates.push(h)
		}
	}
	let best: KnownHead | undefined
	for (const c of candidates) {
		if (!best) {
			best = c
			continue
		}
		// Keep whichever is further along the history.
		if (await isAncestorQuiet(opts.gitDir, best.sha, c.sha)) best = c
	}
	if (!best) return undefined
	const head = await opts.store.get(parseOutpoint(best.outpoint).txid)
	if (!head) return undefined
	const tx = Transaction.fromBinary(Array.from(head))
	const out = tx.outputs[parseOutpoint(best.outpoint).vout]
	if (!out) return undefined
	const token = decodeCommitToken(out.lockingScript)
	opts.log?.(`gib: branching from ${best.outpoint}\n`)
	return { outpoint: best.outpoint, root: parseOutpoint(token.root) }
}

/**
 * For a merge, the head publishing the parent the spend does not cover.
 * The spend is the first parent's lineage; this is the other one, so the
 * head's parents mirror the commit's.
 */
async function mergedFrom(opts: PushState, tip: Uint8Array): Promise<string> {
	const parents = commitParents(tip)
	if (parents.length < 2) return ''
	const heads = opts.knownHeads ?? []
	for (const p of parents.slice(1)) {
		const exact = heads.find((h) => h.sha === p)
		if (exact) return exact.outpoint
	}
	for (const p of parents.slice(1)) {
		for (const h of heads) {
			if (!h.sha) continue
			if (await isAncestorQuiet(opts.gitDir, h.sha, p)) {
				if (!(await isAncestorQuiet(opts.gitDir, h.sha, parents[0]))) {
					return h.outpoint
				}
			}
		}
	}
	// TODO: only one extra parent fits in the token. An octopus merge of
	// three or more parents publishes the first two lineages and leaves the
	// rest for whichever head publishes them.
	return ''
}

async function isAncestorQuiet(
	gitDir: string,
	anc: string,
	desc: string,
): Promise<boolean> {
	try {
		return await isAncestor(gitDir, anc, desc)
	} catch {
		return false
	}
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
	for (let page = 0; page < MAX_PAGES; page++) {
		const answer = await opts.peer.headsSince({
			origin: opts.origin,
			branch,
			identity: opts.identity,
			since,
		})
		for (const h of answer.heads) seen.add(h.outpoint)
		if (!answer.more || answer.heads.length === 0) break
		const next = answer.heads[answer.heads.length - 1].outpoint
		if (next === since) break
		since = next
	}
	const missing: string[] = []
	let cursor: string | undefined = tip
	while (cursor && !seen.has(cursor)) {
		missing.push(cursor)
		cursor = await previousHead(opts.store, cursor).catch(() => undefined)
	}
	for (const outpoint of missing.reverse()) {
		const op = parseOutpoint(outpoint)
		const bytes = await opts.store.get(op.txid)
		if (!bytes) throw new Error(`sync: ${op.txid} is not in the local store`)
		const tx = Transaction.fromBinary(Array.from(bytes))
		const out = tx.outputs[op.vout]
		if (!out) throw new Error(`sync: ${outpoint} is not an output`)
		const token = decodeCommitToken(out.lockingScript)
		const beefs: Array<number[] | Uint8Array> = [rawBeef(bytes)]
		// A peer that has never seen this repository needs the content the
		// head's tree cites, not just the transaction the root is in: the
		// tree reaches back through the whole history.
		const cited = await collectTxids(opts.store, parseOutpoint(token.root))
		if (!cited.complete) {
			opts.log?.(
				`gib: ${outpoint} cites more content than one submission carries; the remote may need a later sync\n`,
			)
		}
		for (const txid of cited.txids) {
			if (txid === op.txid) continue
			const content = await opts.store.get(txid)
			if (content) beefs.push(rawBeef(content))
		}
		await opts.peer.submit(atomicWithExtras(beefs, op.txid))
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
 * spendability; the commit it publishes is read from its tree.
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
	const token = decodeCommitToken(LockingScript.fromHex(o.lockingScript))
	if (token.identityPubkey !== opts.identity) {
		throw new Error(
			`head ${o.outpoint} belongs to identity ${token.identityPubkey}`,
		)
	}
	if (!o.customInstructions) {
		throw new Error('commit head missing customInstructions')
	}
	const ci = JSON.parse(o.customInstructions) as { keyID?: string }
	if (!ci.keyID) throw new Error('customInstructions missing keyID')
	if (!listed.BEEF?.length) {
		throw new Error(`wallet returned no BEEF for ${o.outpoint}`)
	}
	const outpoint = o.outpoint.replace('.', '_')
	const known = opts.knownHeads?.find((h) => h.outpoint === outpoint)
	// The sha is in the tree, not on the head, so prefer what is already
	// known and only read the root when it is not.
	const sha = known?.sha || (await tipSha(opts.store, parseOutpoint(token.root)))
	return {
		outpoint,
		root: token.root,
		sha,
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
	return {
		ok: true,
		dst,
		branch,
		sha: NULL_SHA,
		head: '',
		minted: true,
		branchedFrom: '',
	}
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
