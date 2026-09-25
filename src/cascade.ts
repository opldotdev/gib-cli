/**
 * The cascade: turning one commit's file list into the outputs that
 * publish its tree.
 *
 * Only what changed is written. An unchanged file is cited at the outpoint
 * that already holds it; a changed file whose previous bytes live at a real
 * outpoint becomes an `ordfs/patch` against it; everything else is written
 * whole. Directory manifests are rebuilt from the leaves up, and a
 * directory nothing touched is cited rather than rewritten.
 *
 * Nothing here decides which transaction an output lands in. A plan is a
 * list of nodes in dependency order — children before the directory that
 * names them — with references by node, not by vout. Packing them into
 * transactions is `chain.ts`'s job, which is what lets one push carry
 * several commits' trees, and lets a tree spill across transactions when
 * it is too big for one.
 */

import {
	DIR_CONTENT_TYPE,
	type DirEntry,
	type DirRef,
	dirEncode,
	dirName,
} from './ordfs/dir.ts'
import { PATCH_CONTENT_TYPE, patchFromContent } from './ordfs/patch.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import { collectSnapshot, GIT_DIR } from './tree.ts'
import { resolveOutpoint } from './resolver.ts'
import { dirDecode, dirNameString } from './ordfs/dir.ts'
import type { TxStore } from './txstore.ts'

export type IncomingFile = {
	path: string
	bytes: Uint8Array
	contentType?: string
	exec?: boolean
	symlink?: boolean
}

/** Where a directory entry points while a plan is still being built. */
export type PlanRef = { kind: 'node'; id: number } | DirRef

export type PlanEntry = {
	name: string
	isDir: boolean
	exec?: boolean
	symlink?: boolean
	ref: PlanRef
}

export type PlanNode =
	| { kind: 'data'; contentType: string; bytes: Uint8Array; label: string }
	| { kind: 'dir'; entries: PlanEntry[]; label: string }

/** A plan under construction: nodes in dependency order. */
export class Plan {
	readonly nodes: PlanNode[] = []

	add(node: PlanNode): number {
		this.nodes.push(node)
		return this.nodes.length - 1
	}

	get size(): number {
		return this.nodes.length
	}
}

/** One published file: its bytes and where the tree points at them. */
export type TreeFile = {
	bytes: Uint8Array
	ref: PlanRef
	exec?: boolean
	symlink?: boolean
	/** Set once the bytes live in a transaction with a known txid. */
	outpoint?: Outpoint
}

/** A tree, as the next commit in a push needs to see it. */
export type Tree = {
	files: Map<string, TreeFile>
	dirs: Map<string, PlanRef>
}

export type CommitPlan = {
	/** The node holding this commit's root directory. */
	rootId: number
	/** The tree those nodes publish. */
	tree: Tree
}

/** The largest vout an `ordfs/dir` same-transaction reference can name. */
export const MAX_SAME_TX_VOUT = 255

function parentDir(path: string): string {
	const i = path.lastIndexOf('/')
	return i < 0 ? '' : path.slice(0, i)
}

function basename(path: string): string {
	const i = path.lastIndexOf('/')
	return i < 0 ? path : path.slice(i + 1)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

/** What a published root holds: git's tree, and the `.git` object store. */
export type PublishedRoot = {
	tree: Tree
	/** `.git` entries by name — commit shas and tree shas — as references. */
	objects: Map<string, { ref: DirRef; isDir: boolean }>
}

/**
 * Read a published root for planning the next push: the tip's tree in
 * full, and the `.git` store as references only.
 *
 * The object store is deliberately not descended into. Its entries are
 * named by sha, so a name is proof of content: to cite an object already
 * on chain gib needs its reference, never its bytes. Reading them would
 * mean pulling every version of every file in the repository's history
 * into memory on every push.
 */
export async function loadPublishedRoot(
	store: TxStore,
	root: Outpoint,
): Promise<PublishedRoot> {
	const node = await resolveOutpoint(store, root)
	if (node.contentType !== DIR_CONTENT_TYPE) {
		throw new Error(`published root ${formatOutpoint(root)} is not a directory`)
	}
	const manifest = dirDecode(node.bytes)
	const files = new Map<string, TreeFile>()
	const dirs = new Map<string, PlanRef>()
	const objects = new Map<string, { ref: DirRef; isDir: boolean }>()
	for (const e of manifest.entries) {
		const name = dirNameString(e.name)
		const ref: DirRef =
			e.ref.kind === 'same-tx'
				? { kind: 'outpoint', txid: root.txid, vout: e.ref.vout }
				: { kind: 'outpoint', txid: e.ref.txid.toLowerCase(), vout: e.ref.vout }
		const child: Outpoint = { txid: ref.txid, vout: ref.vout }
		if (name === GIT_DIR) {
			const store0 = await resolveOutpoint(store, child)
			for (const o of dirDecode(store0.bytes).entries) {
				const oref: DirRef =
					o.ref.kind === 'same-tx'
						? { kind: 'outpoint', txid: child.txid, vout: o.ref.vout }
						: { kind: 'outpoint', txid: o.ref.txid.toLowerCase(), vout: o.ref.vout }
				objects.set(dirNameString(o.name), { ref: oref, isDir: o.isDir })
			}
			continue
		}
		if (e.isDir) {
			const sub = await collectSnapshot(store, child, name)
			for (const f of sub.files) {
				files.set(f.path, {
					bytes: f.bytes,
					ref: { kind: 'outpoint', txid: f.outpoint.txid, vout: f.outpoint.vout },
					exec: f.exec,
					symlink: f.symlink,
					outpoint: f.outpoint,
				})
			}
			for (const [path, op] of sub.dirs) {
				dirs.set(path, { kind: 'outpoint', txid: op.txid, vout: op.vout })
			}
			continue
		}
		const file = await resolveOutpoint(store, child)
		files.set(name, {
			bytes: file.bytes,
			ref,
			exec: e.exec,
			symlink: e.symlink,
			outpoint: child,
		})
	}
	return { tree: { files, dirs }, objects }
}

/** Direct child names of a directory, from a set of paths. */
function childNames(paths: Iterable<string>, dir: string): Set<string> {
	const out = new Set<string>()
	for (const p of paths) {
		if (p !== '' && parentDir(p) === dir) out.add(basename(p))
	}
	return out
}

function sameNames(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const x of a) if (!b.has(x)) return false
	return true
}

/**
 * Plan the outputs that publish one commit's tree, appending them to
 * `plan`. The returned root node is git's tree for that commit and nothing
 * else — the `.git` store is added to the tip's root separately, by the
 * caller, so that every other commit's tree stays exactly what git hashed.
 */
export async function planCommit(opts: {
	files: IncomingFile[]
	/** The tree a previous commit published, when there is one to cite. */
	prev?: Tree
	plan: Plan
}): Promise<CommitPlan> {
	const plan = opts.plan
	const prevFiles = opts.prev?.files ?? new Map<string, TreeFile>()
	const prevDirs = opts.prev?.dirs ?? new Map<string, PlanRef>()

	const fileRef = new Map<string, PlanRef>()
	const changed = new Set<string>()

	for (const f of opts.files) {
		const prev = prevFiles.get(f.path)
		const modeSame =
			!!prev && !!prev.exec === !!f.exec && !!prev.symlink === !!f.symlink
		if (prev && bytesEqual(prev.bytes, f.bytes)) {
			// Identical content is a citation, never a no-op patch. A mode
			// change still rewrites the parent directory (flags live there).
			fileRef.set(f.path, prev.ref)
			if (!modeSame) changed.add(f.path)
			continue
		}
		changed.add(f.path)
		if (prev?.outpoint) {
			// A patch needs a base that already has a txid; bytes still
			// waiting in this same push cannot be one, so they are written
			// whole.
			const bytes = await patchFromContent({
				base: prev.outpoint,
				source: prev.bytes,
				target: f.bytes,
			})
			fileRef.set(f.path, {
				kind: 'node',
				id: plan.add({
					kind: 'data',
					contentType: PATCH_CONTENT_TYPE,
					bytes,
					label: f.path,
				}),
			})
			continue
		}
		fileRef.set(f.path, {
			kind: 'node',
			id: plan.add({
				kind: 'data',
				contentType: f.contentType ?? 'application/octet-stream',
				bytes: f.bytes,
				label: f.path,
			}),
		})
	}

	// Every directory of the new tree, and what sits directly in each.
	const dirs = new Set<string>([''])
	for (const f of opts.files) {
		let d = parentDir(f.path)
		for (;;) {
			dirs.add(d)
			if (!d) break
			d = parentDir(d)
		}
	}
	const children = new Map<string, Set<string>>()
	const add = (parent: string, path: string) => {
		let set = children.get(parent)
		if (!set) {
			set = new Set()
			children.set(parent, set)
		}
		set.add(path)
	}
	for (const d of dirs) if (d) add(parentDir(d), d)
	for (const f of opts.files) add(parentDir(f.path), f.path)

	// A directory is rebuilt when a child of it changed, when its child set
	// differs from the tree the previous commit published, or when it is new.
	// A rebuilt directory changes its parent's reference, so that cascades up.
	const prevPaths = [...prevFiles.keys(), ...prevDirs.keys()]
	const touched = new Set<string>([''])
	for (const d of dirs) {
		const wasThere = d === '' || prevDirs.has(d)
		if (
			!opts.prev ||
			!wasThere ||
			!sameNames(
				childNames([...(children.get(d) ?? [])], d),
				childNames(prevPaths, d),
			)
		) {
			touched.add(d)
		}
	}
	for (const path of changed) touched.add(parentDir(path))
	for (const d of [...touched]) {
		let p = d
		while (p) {
			p = parentDir(p)
			touched.add(p)
		}
	}

	const deepestFirst = [...dirs].sort(
		(a, b) =>
			b.split('/').filter(Boolean).length - a.split('/').filter(Boolean).length,
	)
	const byPath = new Map(opts.files.map((f) => [f.path, f]))
	const dirRef = new Map<string, PlanRef>()
	for (const d of deepestFirst) {
		if (!touched.has(d)) {
			const cited = prevDirs.get(d)
			if (cited) {
				dirRef.set(d, cited)
				continue
			}
		}
		const entries: PlanEntry[] = []
		for (const path of [...(children.get(d) ?? [])].sort()) {
			const name = basename(path)
			if (dirs.has(path)) {
				const ref = dirRef.get(path)
				// Children are planned before their parent, so this is a bug
				// rather than a case: dropping the entry silently would
				// publish a tree missing a whole subdirectory.
				if (!ref) throw new Error(`cascade: no reference for directory ${path}`)
				entries.push({ name, isDir: true, ref })
				continue
			}
			const ref = fileRef.get(path)
			if (!ref) throw new Error(`cascade: no reference for file ${path}`)
			const file = byPath.get(path)
			entries.push({
				name,
				isDir: false,
				exec: file?.exec,
				symlink: file?.symlink,
				ref,
			})
		}
		dirRef.set(d, {
			kind: 'node',
			id: plan.add({ kind: 'dir', entries, label: d || '/' }),
		})
	}

	const root = dirRef.get('')
	if (!root || root.kind !== 'node') throw new Error('cascade: missing root dir')

	const tree: Tree = {
		files: new Map(
			opts.files.map((f) => {
				const ref = fileRef.get(f.path) as PlanRef
				return [
					f.path,
					{
						bytes: f.bytes,
						ref,
						exec: f.exec,
						symlink: f.symlink,
						outpoint:
							ref.kind === 'outpoint' ? { txid: ref.txid, vout: ref.vout } : undefined,
					},
				]
			}),
		),
		dirs: new Map(dirRef),
	}
	return { rootId: root.id, tree }
}

/** Encode a planned directory once every reference is a real one. */
export function encodePlannedDir(entries: DirEntry[]): Uint8Array {
	return dirEncode({ version: 1, entries })
}

/** A planned entry with its reference resolved, ready to encode. */
export function toDirEntry(entry: PlanEntry, ref: DirRef): DirEntry {
	return {
		name: dirName(entry.name),
		isDir: entry.isDir,
		exec: entry.exec,
		symlink: entry.symlink,
		ref,
	}
}
