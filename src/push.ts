import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planCommit } from './cascade.ts'
import {
	commitBytes,
	filesAtCommit,
	isAncestor,
	parsePushLine,
	revParse,
} from './gitread.ts'
import { formatOutpoint, parseOutpoint } from './outpoint.ts'
import { clearPending, savePending } from './pending.ts'
import { headTags, type Publisher } from './publish.ts'
import { advertise } from './remote/advertise.ts'
import { validateRoot } from './validate.ts'
import {
	branchTag,
	decodeCommitToken,
	GIB_BASKET,
	originTag,
	pushLabel,
} from './token.ts'
import type { TxStore } from './txstore.ts'
import type { WalletInterface } from '@bsv/sdk'

export type PushResult =
	| { ok: true; dst: string; origin: string; sha: string }
	| { ok: false; dst: string; error: string }

export async function pushLine(opts: {
	line: string
	gitDir: string
	store: TxStore
	wallet: WalletInterface
	publisher: Publisher
	origin: string
	home?: string
}): Promise<PushResult> {
	const spec = parsePushLine(opts.line)
	const branch = spec.dst.replace(/^refs\/heads\//, '')
	if (spec.del) {
		return burnRef(opts, spec.dst, branch)
	}
	try {
		const sha = await revParse(opts.gitDir, spec.src)
		const commit = await commitBytes(opts.gitDir, sha)
		const files = await filesAtCommit(opts.gitDir, sha)
		const refs = await advertise(opts.wallet, opts.store, opts.origin)
		const current = refs.find((r) => r.name === spec.dst || r.name === `refs/heads/${branch}`)
		if (current && current.sha !== sha) {
			const ff = await isAncestor(opts.gitDir, current.sha, sha)
			if (!ff && !spec.force) {
				return { ok: false, dst: spec.dst, error: 'non-fast-forward' }
			}
			if (current.sha !== (await remoteSha(opts, branch))) {
				return { ok: false, dst: spec.dst, error: 'token sha mismatch' }
			}
		}

		const prev = await currentToken(opts, branch)
		const genesis = !prev && (opts.origin === '' || opts.origin === 'new')
		const plan = await planCommit({
			files,
			prevRoot: prev ? parseOutpoint(prev.root) : undefined,
			store: prev ? opts.store : undefined,
		})
		const labels = [pushLabel(sha)]
		const content = await opts.publisher.publishContent(plan, labels)
		await opts.store.put(content.txid, content.bytes)
		await savePending(sha, [{ phase: 'content', txid: content.txid, bytes: content.bytes }], opts.home)

		const root = { txid: content.txid, vout: plan.rootIndex }
		const scratch = await mkdtemp(join(tmpdir(), 'gib-val-'))
		await validateRoot(opts.store, root, commit, scratch)

		const origin = genesis ? formatOutpoint(root, '_') : prev?.origin ?? opts.origin
		const { publicKey } = await opts.wallet.getPublicKey({ identityKey: true })
		const token = {
			origin,
			branch,
			root: formatOutpoint(root, '_'),
			identityPubkey: publicKey,
		}
		const spend = prev
			? await loadSpend(opts.wallet, prev.outpoint)
			: undefined
		const head = await opts.publisher.publishHead({
			token,
			commitBytes: commit,
			labels,
			tags: headTags(origin, branch),
			spend,
		})
		await opts.store.put(head.txid, head.bytes)
		await clearPending(sha, opts.home)
		return { ok: true, dst: spec.dst, origin, sha }
	} catch (e) {
		return {
			ok: false,
			dst: spec.dst,
			error: e instanceof Error ? e.message : String(e),
		}
	}
}

async function burnRef(
	opts: {
		wallet: WalletInterface
		publisher: Publisher
		store: TxStore
		origin: string
	},
	dst: string,
	branch: string,
): Promise<PushResult> {
	const prev = await currentToken(opts, branch)
	if (!prev) return { ok: false, dst, error: 'no such ref' }
	const spend = await loadSpend(opts.wallet, prev.outpoint)
	if (!spend) return { ok: false, dst, error: 'token not in wallet' }
	await opts.publisher.burnHead({
		outpoint: spend.outpoint,
		beef: spend.beef,
		keyID: prev.root,
		labels: [pushLabel('delete')],
	})
	return { ok: true, dst, origin: opts.origin, sha: '0000000000000000000000000000000000000000' }
}

async function currentToken(
	opts: { wallet: WalletInterface; origin: string },
	branch: string,
): Promise<{ origin: string; root: string; outpoint: string } | undefined> {
	if (opts.origin === '' || opts.origin === 'new') return undefined
	const listed = await opts.wallet.listOutputs({
		basket: GIB_BASKET,
		tags: [originTag(opts.origin), branchTag(branch)],
		tagQueryMode: 'all',
		include: 'locking scripts',
		limit: 1,
	})
	const o = listed.outputs?.[0]
	if (!o?.lockingScript) return undefined
	const t = decodeCommitToken(o.lockingScript)
	return { origin: t.origin, root: t.root, outpoint: o.outpoint }
}

async function remoteSha(
	opts: { wallet: WalletInterface; store: TxStore; origin: string },
	branch: string,
): Promise<string | undefined> {
	const refs = await advertise(opts.wallet, opts.store, opts.origin)
	return refs.find((r) => r.name === `refs/heads/${branch}`)?.sha
}

async function loadSpend(
	wallet: WalletInterface,
	outpoint: string,
): Promise<{ outpoint: string; beef: number[] } | undefined> {
	const listed = await wallet.listOutputs({
		basket: GIB_BASKET,
		include: 'entire transactions',
		limit: 100,
	})
	const want = outpoint.replace('_', '.')
	const hit = listed.outputs?.find((o) => o.outpoint === want)
	if (!hit || !listed.BEEF?.length) return undefined
	return { outpoint: want, beef: Array.from(listed.BEEF) }
}
