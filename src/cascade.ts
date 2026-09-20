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
 * A plan can be appended to a transaction that already has outputs
 * (`baseVout`), which is what lets one content transaction carry every new
 * object for a whole push of N commits. Each plan returns the tree it
 * produced, so the next commit in the chain plans against it without going
 * near the chain.
 */

import {
	DIR_CONTENT_TYPE,
	type DirEntry,
	type DirRef,
	dirEncode,
	dirName,
} from './ordfs/dir.ts'
import { PATCH_CONTENT_TYPE, patchFromContent } from './ordfs/patch.ts'
import type { Outpoint } from './outpoint.ts'
import { collectSnapshot } from './tree.ts'
import type { TxStore } from './txstore.ts'

export type IncomingFile = {
	path: string
	bytes: Uint8Array
	contentType?: string
	exec?: boolean
	symlink?: boolean
}

export type PlannedOutput = {
	contentType: string
	bytes: Uint8Array
	path?: string
}

/** One published file in a tree: its bytes and where the tree points. */
export type TreeFile = {
	bytes: Uint8Array
	ref: DirRef
	exec?: boolean
	symlink?: boolean
	/** Set once the bytes live in a transaction with a known txid. */
	outpoint?: Outpoint
}

/** A published tree, as the next commit in a chain needs to see it. */
export type Tree = {
	files: Map<string, TreeFile>
	dirs: Map<string, DirRef>
}

export type CommitPlan = {
	outputs: PlannedOutput[]
	/** Absolute vout of the root directory in the finished transaction. */
	rootIndex: number
	/** The tree these outputs publish. */
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

/** Read a published tree from the store, for planning the next commit. */
export async function treeFromRoot(
	store: TxStore,
	root: Outpoint,
): Promise<Tree> {
	const snap = await collectSnapshot(store, root)
	const files = new Map<string, TreeFile>()
	for (const f of snap.files) {
		files.set(f.path, {
			bytes: f.bytes,
			ref: { kind: 'outpoint', txid: f.outpoint.txid, vout: f.outpoint.vout },
			exec: f.exec,
			symlink: f.symlink,
			outpoint: f.outpoint,
		})
	}
	const dirs = new Map<string, DirRef>()
	for (const [path, op] of snap.dirs) {
		dirs.set(path, { kind: 'outpoint', txid: op.txid, vout: op.vout })
	}
	return { files, dirs }
}

/**
 * Bind a tree planned into a transaction to that transaction's txid: every
 * same-transaction reference becomes a real outpoint, so the tree can be
 * cited (and patched against) from a later transaction.
 */
export function bindTree(tree: Tree, txid: string): Tree {
	const bind = (ref: DirRef): DirRef =>
		ref.kind === 'same-tx' ? { kind: 'outpoint', txid, vout: ref.vout } : ref
	const files = new Map<string, TreeFile>()
	for (const [path, f] of tree.files) {
		const ref = bind(f.ref)
		files.set(path, {
			...f,
			ref,
			outpoint:
				ref.kind === 'outpoint'
					? { txid: ref.txid, vout: ref.vout }
					: f.outpoint,
		})
	}
	const dirs = new Map<string, DirRef>()
	for (const [path, ref] of tree.dirs) dirs.set(path, bind(ref))
	return { files, dirs }
}

/** Direct child names of a directory, from a set of paths. */
function childNames(paths: Iterable<string>, dir: string): Set<string> {
	const out = new Set<string>()
	for (const p of paths) {
		if (parentDir(p) === dir && p !== '') out.add(basename(p))
	}
	return out
}

function sameNames(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const x of a) if (!b.has(x)) return false
	return true
}

export async function planCommit(opts: {
	files: IncomingFile[]
	/** The tree the previous commit published, when there is one. */
	prev?: Tree
	/** Outputs already in the transaction these will be appended to. */
	baseVout?: number
}): Promise<CommitPlan> {
	const base = opts.baseVout ?? 0
	const prevFiles = opts.prev?.files ?? new Map<string, TreeFile>()
	const prevDirs = opts.prev?.dirs ?? new Map<string, DirRef>()

	const outputs: PlannedOutput[] = []
	const vout = () => base + outputs.length
	const fileRef = new Map<string, DirRef>()
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
			// waiting in this same transaction cannot be one, so they are
			// written whole.
			const bytes = await patchFromContent({
				base: prev.outpoint,
				source: prev.bytes,
				target: f.bytes,
			})
			fileRef.set(f.path, { kind: 'same-tx', vout: vout() })
			outputs.push({
				contentType: PATCH_CONTENT_TYPE,
				bytes,
				path: f.path,
			})
			continue
		}
		fileRef.set(f.path, { kind: 'same-tx', vout: vout() })
		outputs.push({
			contentType: f.contentType ?? 'application/octet-stream',
			bytes: f.bytes,
			path: f.path,
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
				childNames(
					[...(children.get(d) ?? [])],
					d,
				),
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
	const dirRef = new Map<string, DirRef>()
	for (const d of deepestFirst) {
		if (!touched.has(d)) {
			const cited = prevDirs.get(d)
			if (cited) {
				dirRef.set(d, cited)
				continue
			}
		}
		const entries: DirEntry[] = []
		for (const path of [...(children.get(d) ?? [])].sort()) {
			const name = dirName(basename(path))
			if (dirs.has(path)) {
				const ref = dirRef.get(path)
				// Children are planned before their parent, so this is a
				// bug rather than a case: dropping the entry silently would
				// publish a tree missing a whole subdirectory.
				if (!ref) throw new Error(`cascade: no reference for directory ${path}`)
				entries.push({ name, isDir: true, ref })
				continue
			}
			const ref = fileRef.get(path)
			if (!ref) throw new Error(`cascade: no reference for file ${path}`)
			const file = opts.files.find((x) => x.path === path)
			entries.push({
				name,
				isDir: false,
				exec: file?.exec,
				symlink: file?.symlink,
				ref,
			})
		}
		dirRef.set(d, { kind: 'same-tx', vout: vout() })
		outputs.push({
			contentType: DIR_CONTENT_TYPE,
			bytes: dirEncode({ version: 1, entries }),
			path: d || '/',
		})
	}

	const root = dirRef.get('')
	if (!root || root.kind !== 'same-tx') {
		throw new Error('cascade: missing root dir')
	}

	const tree: Tree = {
		files: new Map(
			opts.files.map((f) => [
				f.path,
				{
					bytes: f.bytes,
					ref: fileRef.get(f.path) as DirRef,
					exec: f.exec,
					symlink: f.symlink,
					outpoint: outpointOf(fileRef.get(f.path) as DirRef),
				},
			]),
		),
		dirs: new Map(dirRef),
	}
	return { outputs, rootIndex: root.vout, tree }
}

function outpointOf(ref: DirRef): Outpoint | undefined {
	return ref.kind === 'outpoint' ? { txid: ref.txid, vout: ref.vout } : undefined
}
