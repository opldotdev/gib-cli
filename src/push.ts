import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WalletInterface } from '@bsv/sdk'
import { planCommit } from './cascade.ts'
import {
	commitBytes,
	filesAtCommit,
	isAncestor,
	parsePushLine,
	revParse,
} from './gitread.ts'
import { loadBasketOutputBeef } from '@1sat/actions'
import { formatOutpoint, parseOutpoint } from './outpoint.ts'
import { clearPending, loadPending, savePending } from './pending.ts'
import { previewContentStore } from './preview.ts'
import { headTags, type Publisher } from './publish.ts'
import { recoverPush } from './recovery.ts'
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
		await recoverForPush(opts.wallet, opts.store, sha)

		const commit = await commitBytes(opts.gitDir, sha)
		const files = await filesAtCommit(opts.gitDir, sha)
		const refs = await advertise(opts.wallet, opts.store, opts.origin)
		const current = refs.find(
			(r) => r.name === spec.dst || r.name === `refs/heads/${branch}`,
		)
		if (current && current.sha !== sha) {
			const ff = await isAncestor(opts.gitDir, current.sha, sha)
			if (!ff && !spec.force) {
				return { ok: false, dst: spec.dst, error: 'non-fast-forward' }
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
		const scratch = await mkdtemp(join(tmpdir(), 'gib-val-'))
		const preview = previewContentStore(plan, opts.store)
		await validateRoot(preview.store, preview.root, commit, scratch)

		const pending = await loadPending(sha, opts.home)
		const resumed = pending?.find((t) => t.phase === 'content')
		let content = resumed
			? { txid: resumed.txid, bytes: resumed.bytes }
			: await opts.publisher.publishContent(plan, labels)
		await opts.store.put(content.txid, content.bytes)
		await savePending(
			sha,
			[{ phase: 'content', txid: content.txid, bytes: content.bytes }],
			opts.home,
		)

		const root = { txid: content.txid, vout: plan.rootIndex }
		const origin = genesis ? formatOutpoint(root, '_') : prev?.origin ?? opts.origin
		const { publicKey } = await opts.wallet.getPublicKey({ identityKey: true })
		const token = {
			origin,
			branch,
			root: formatOutpoint(root, '_'),
			identityPubkey: publicKey,
		}
		const spend = prev ? await loadSpendById(opts.wallet, prev.id) : undefined
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

async function recoverForPush(
	wallet: WalletInterface,
	store: TxStore,
	sha: string,
): Promise<void> {
	const plans = await recoverPush(wallet, store, sha)
	for (const p of plans) {
		if (p.kind === 'abort') {
			await wallet.abortAction({ reference: p.reference })
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
	const spend = await loadSpendById(opts.wallet, prev.id)
	await opts.publisher.burnHead({
		...spend,
		labels: [pushLabel('delete')],
	})
	return { ok: true, dst, origin: opts.origin, sha: '0000000000000000000000000000000000000000' }
}

async function currentToken(
	opts: { wallet: WalletInterface; origin: string },
	branch: string,
): Promise<{ origin: string; root: string; outpoint: string; id: string } | undefined> {
	if (opts.origin === '' || opts.origin === 'new') return undefined
	const listed = await opts.wallet.listOutputs({
		basket: GIB_BASKET,
		tags: [originTag(opts.origin), branchTag(branch)],
		tagQueryMode: 'all',
		include: 'locking scripts',
		includeTags: true,
		includeCustomInstructions: true,
		limit: 1,
	})
	const o = listed.outputs?.[0]
	if (!o?.lockingScript) return undefined
	const id = o.tags?.find((t) => t.startsWith('id:'))
	if (!id) throw new Error('commit token missing id: tag')
	const t = decodeCommitToken(o.lockingScript)
	return { origin: t.origin, root: t.root, outpoint: o.outpoint, id }
}

async function loadSpendById(
	wallet: WalletInterface,
	id: string,
): Promise<{ outpoint: string; beef: number[]; keyID: string }> {
	const loaded = await loadBasketOutputBeef(wallet, GIB_BASKET, id)
	if ('error' in loaded) throw new Error(loaded.error)
	if (!loaded.output.customInstructions) {
		throw new Error('commit token missing customInstructions')
	}
	const ci = JSON.parse(loaded.output.customInstructions) as { keyID?: string }
	if (!ci.keyID) throw new Error('customInstructions missing keyID')
	return {
		outpoint: loaded.output.outpoint,
		beef: loaded.beef,
		keyID: ci.keyID,
	}
}
