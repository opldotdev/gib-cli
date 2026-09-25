import { Transaction } from '@bsv/sdk'
import { payloadFromScript } from './content.ts'
import {
	DIR_CONTENT_TYPE,
	dirDecode,
	dirDefault,
	dirNameString,
	type DirEntry,
	JSON_MANIFEST_CONTENT_TYPE_LEGACY,
} from './ordfs/dir.ts'
import {
	PATCH_CONTENT_TYPE,
	patchApply,
	patchDecode,
} from './ordfs/patch.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import type { TxStore } from './txstore.ts'

export const MAX_DIRECTORY_DEPTH = 8

export type Resolved = {
	contentType: string
	bytes: Uint8Array
	outpoint: Outpoint
}

export class ResolveError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ResolveError'
	}
}

export async function loadTx(
	store: TxStore,
	txid: string,
): Promise<Transaction> {
	const bytes = await store.get(txid)
	if (!bytes) throw new ResolveError(`missing tx ${txid}`)
	return Transaction.fromBinary(Array.from(bytes))
}

export async function resolveOutpoint(
	store: TxStore,
	op: Outpoint,
	seen = new Set<string>(),
): Promise<Resolved> {
	const key = formatOutpoint(op)
	if (seen.has(key)) throw new ResolveError(`patch cycle at ${key}`)
	const tx = await loadTx(store, op.txid)
	const out = tx.outputs[op.vout]
	if (!out) throw new ResolveError(`missing output ${formatOutpoint(op)}`)
	const payload = payloadFromScript(out.lockingScript)
	if (!payload) {
		throw new ResolveError(`no content at ${formatOutpoint(op)}`)
	}
	if (payload.contentType === PATCH_CONTENT_TYPE) {
		seen.add(key)
		const rec = patchDecode(payload.bytes)
		const base = await resolveOutpoint(store, rec.base, seen)
		const bytes = await patchApply(rec, base.bytes)
		return { contentType: base.contentType, bytes, outpoint: op }
	}
	return {
		contentType: payload.contentType,
		bytes: payload.bytes,
		outpoint: op,
	}
}

export async function resolvePath(
	store: TxStore,
	root: Outpoint,
	path = '',
): Promise<Resolved> {
	const segments = path.split('/').filter((s) => s.length > 0)
	return walkDir(store, root, segments, 0)
}

async function walkDir(
	store: TxStore,
	op: Outpoint,
	segments: string[],
	depth: number,
): Promise<Resolved> {
	if (depth > MAX_DIRECTORY_DEPTH) {
		throw new ResolveError('max directory depth exceeded')
	}
	const node = await resolveOutpoint(store, op)
	const isDir =
		node.contentType === DIR_CONTENT_TYPE ||
		node.contentType === JSON_MANIFEST_CONTENT_TYPE_LEGACY
	if (!isDir) {
		if (segments.length) {
			throw new ResolveError(`not a directory: ${formatOutpoint(op)}`)
		}
		return node
	}
	if (node.contentType === JSON_MANIFEST_CONTENT_TYPE_LEGACY) {
		throw new ResolveError('legacy ord-fs/json not implemented in resolver')
	}
	const manifest = dirDecode(node.bytes)
	if (!segments.length) {
		const def = dirDefault(manifest)
		if (!def) return node
		return walkEntry(store, op.txid, def, [], depth)
	}
	const name = segments[0]
	const entry = manifest.entries.find((e) => dirNameString(e.name) === name)
	if (!entry) throw new ResolveError(`no entry "${name}"`)
	return walkEntry(store, op.txid, entry, segments.slice(1), depth)
}

async function walkEntry(
	store: TxStore,
	parentTxid: string,
	entry: DirEntry,
	rest: string[],
	depth: number,
): Promise<Resolved> {
	const child: Outpoint =
		entry.ref.kind === 'same-tx'
			? { txid: parentTxid, vout: entry.ref.vout }
			: { txid: entry.ref.txid.toLowerCase(), vout: entry.ref.vout }
	if (entry.isDir) return walkDir(store, child, rest, depth + 1)
	if (rest.length) {
		throw new ResolveError(`not a directory: ${dirNameString(entry.name)}`)
	}
	return resolveOutpoint(store, child)
}
