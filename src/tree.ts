/**
 * Reading a published tree back: the directory graph on chain, and the git
 * objects it reconstructs.
 *
 * The published root is git's tree for the commit plus one extra entry,
 * `.git`, which is the repository's own object store: every commit object
 * reachable from the tip, and every one of those commits' trees, each named
 * by its sha. Stripping that entry gives back exactly the tree git hashed —
 * see stripGitDir, which is the only place the model bends.
 */

import { DIR_CONTENT_TYPE, dirDecode, dirNameString } from './ordfs/dir.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import { resolveOutpoint } from './resolver.ts'
import type { TxStore } from './txstore.ts'
import { encodeTree, gitHash, treeEntryMode, writeGitObject } from './git.ts'

/**
 * THE ONE SPECIAL CASE IN THE WHOLE MODEL.
 *
 * gib publishes git's tree for a commit and adds a single entry to the
 * root, `.git`, holding the commit objects and ancestor trees that make the
 * history self-contained. git itself refuses to put a `.git` entry in a
 * tree, so the name can never collide with a real file — and every place
 * that turns a published tree back into git's tree MUST strip it first, or
 * the tree sha will not match and the commit will not verify.
 *
 * If you are adding a second thing to the published root: don't. Put it
 * inside `.git`.
 */
export const GIT_DIR = '.git'

/** Files of a published tree with the `.git` object store removed. */
export function stripGitDir(files: FileEntry[]): FileEntry[] {
	return files.filter((f) => !isGitDirPath(f.path))
}

export function isGitDirPath(path: string): boolean {
	return path === GIT_DIR || path.startsWith(`${GIT_DIR}/`)
}

export type FileEntry = {
	path: string
	bytes: Uint8Array
	contentType: string
	outpoint: Outpoint
	exec?: boolean
	symlink?: boolean
}

export type TreeSnapshot = {
	files: FileEntry[]
	dirs: Map<string, Outpoint>
}

/** How deep a published directory graph may go before we call it broken. */
export const MAX_TREE_DEPTH = 64

type Walk = {
	/** Directories on the path being walked right now: a real cycle. */
	stack: Set<string>
	/** Subtrees already read, relative to themselves. */
	memo: Map<string, TreeSnapshot>
}

/** One entry of a published directory, with its outpoint resolved. */
export type DirChild = {
	name: string
	isDir: boolean
	exec?: boolean
	symlink?: boolean
	outpoint: Outpoint
}

/** Read one directory manifest, without descending into it. */
export async function readDir(
	store: TxStore,
	dir: Outpoint,
): Promise<DirChild[]> {
	const node = await resolveOutpoint(store, dir)
	if (node.contentType !== DIR_CONTENT_TYPE) {
		throw new Error(`${formatOutpoint(dir)} is not a directory`)
	}
	return dirDecode(node.bytes).entries.map((e) => ({
		name: dirNameString(e.name),
		isDir: e.isDir,
		exec: e.exec,
		symlink: e.symlink,
		outpoint:
			e.ref.kind === 'same-tx'
				? { txid: dir.txid, vout: e.ref.vout }
				: { txid: e.ref.txid.toLowerCase(), vout: e.ref.vout },
	}))
}

export async function collectTree(
	store: TxStore,
	root: Outpoint,
	prefix = '',
): Promise<FileEntry[]> {
	return (await collectSnapshot(store, root, prefix)).files
}

/**
 * Every file under a published directory, with the outpoint each came
 * from.
 *
 * Two different paths may legitimately reach the same directory — an
 * ancestor tree in `.git` shares every subdirectory that has not changed
 * since — so a cycle is a directory that contains *itself*, not one that is
 * read twice. Subtrees are read once and reused.
 */
export async function collectSnapshot(
	store: TxStore,
	root: Outpoint,
	prefix = '',
	walk: Walk = { stack: new Set(), memo: new Map() },
	depth = 0,
): Promise<TreeSnapshot> {
	const key = formatOutpoint(root)
	if (walk.stack.has(key)) throw new Error(`directory cycle at ${key}`)
	if (depth > MAX_TREE_DEPTH) {
		throw new Error(`directory nested deeper than ${MAX_TREE_DEPTH} at ${key}`)
	}
	const cached = walk.memo.get(key)
	if (cached) return reprefix(cached, prefix)

	const node = await resolveOutpoint(store, root)
	if (node.contentType !== DIR_CONTENT_TYPE) {
		return {
			files: [
				{
					path: prefix || key,
					bytes: node.bytes,
					contentType: node.contentType,
					outpoint: node.outpoint,
				},
			],
			dirs: new Map(),
		}
	}
	walk.stack.add(key)
	const manifest = dirDecode(node.bytes)
	const files: FileEntry[] = []
	const dirs = new Map<string, Outpoint>([['', root]])
	for (const e of manifest.entries) {
		const name = dirNameString(e.name)
		const child: Outpoint =
			e.ref.kind === 'same-tx'
				? { txid: root.txid, vout: e.ref.vout }
				: { txid: e.ref.txid.toLowerCase(), vout: e.ref.vout }
		if (e.isDir) {
			// The recursive call already carries the child's name, so its
			// paths arrive prefixed: merge them as they are.
			const sub = await collectSnapshot(store, child, name, walk, depth + 1)
			files.push(...sub.files)
			for (const [k, v] of sub.dirs) dirs.set(k, v)
		} else {
			const file = await resolveOutpoint(store, child)
			files.push({
				path: name,
				bytes: file.bytes,
				contentType: file.contentType,
				outpoint: file.outpoint,
				exec: e.exec,
				symlink: e.symlink,
			})
		}
	}
	walk.stack.delete(key)
	const snapshot: TreeSnapshot = { files, dirs }
	walk.memo.set(key, snapshot)
	return reprefix(snapshot, prefix)
}

function reprefix(snapshot: TreeSnapshot, prefix: string): TreeSnapshot {
	if (!prefix) return snapshot
	return {
		files: snapshot.files.map((f) => ({ ...f, path: `${prefix}/${f.path}` })),
		dirs: new Map(
			[...snapshot.dirs].map(([k, v]) => [k ? `${prefix}/${k}` : prefix, v]),
		),
	}
}

/**
 * Write a file list into git as a tree, and return the tree sha. The files
 * must already have `.git` stripped: this is git's tree, not gib's root.
 */
export async function writeTree(
	gitDir: string,
	files: FileEntry[],
): Promise<string> {
	type Node = { files: FileEntry[]; dirs: Map<string, Node> }
	const root: Node = { files: [], dirs: new Map() }
	for (const f of files) {
		const parts = f.path.split('/')
		let n = root
		for (let i = 0; i < parts.length - 1; i++) {
			let d = n.dirs.get(parts[i])
			if (!d) {
				d = { files: [], dirs: new Map() }
				n.dirs.set(parts[i], d)
			}
			n = d
		}
		n.files.push(f)
	}

	async function writeNode(n: Node): Promise<string> {
		const entries: Array<{ mode: string; name: string; sha: string }> = []
		for (const [name, child] of n.dirs) {
			entries.push({
				mode: treeEntryMode({ dir: true }),
				name,
				sha: await writeNode(child),
			})
		}
		for (const f of n.files) {
			entries.push({
				mode: treeEntryMode({ exec: f.exec, symlink: f.symlink }),
				name: f.path.split('/').pop() ?? f.path,
				sha: await writeGitObject(gitDir, 'blob', f.bytes),
			})
		}
		return writeGitObject(gitDir, 'tree', encodeTree(entries))
	}

	return writeNode(root)
}

/** Write a tree and a commit object, and return both shas. */
export async function materializeGit(
	gitDir: string,
	files: FileEntry[],
	commitBytes: Uint8Array,
): Promise<{ commit: string; tree: string }> {
	const tree = await writeTree(gitDir, files)
	await writeGitObject(gitDir, 'commit', commitBytes)
	return { commit: gitHash('commit', commitBytes), tree }
}
