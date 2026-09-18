import { DIR_CONTENT_TYPE, dirDecode, dirNameString } from './ordfs/dir.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import { resolveOutpoint } from './resolver.ts'
import type { TxStore } from './txstore.ts'
import { encodeTree, gitHash, treeEntryMode, writeGitObject } from './git.ts'

export type FileEntry = {
	path: string
	bytes: Uint8Array
	contentType: string
	outpoint: Outpoint
	exec?: boolean
	symlink?: boolean
}

export async function collectTree(
	store: TxStore,
	root: Outpoint,
	prefix = '',
): Promise<FileEntry[]> {
	const node = await resolveOutpoint(store, root)
	if (node.contentType !== DIR_CONTENT_TYPE) {
		return [
			{
				path: prefix || formatOutpoint(root),
				bytes: node.bytes,
				contentType: node.contentType,
				outpoint: node.outpoint,
			},
		]
	}
	const manifest = dirDecode(node.bytes)
	const out: FileEntry[] = []
	for (const e of manifest.entries) {
		const name = dirNameString(e.name)
		const child: Outpoint =
			e.ref.kind === 'same-tx'
				? { txid: root.txid, vout: e.ref.vout }
				: { txid: e.ref.txid.toLowerCase(), vout: e.ref.vout }
		if (e.isDir) {
			out.push(...(await collectTree(store, child, prefix ? `${prefix}/${name}` : name)))
		} else {
			const file = await resolveOutpoint(store, child)
			out.push({
				path: prefix ? `${prefix}/${name}` : name,
				bytes: file.bytes,
				contentType: file.contentType,
				outpoint: file.outpoint,
				exec: e.exec,
				symlink: e.symlink,
			})
		}
	}
	return out
}

export async function materializeGit(
	gitDir: string,
	files: FileEntry[],
	commitBytes: Uint8Array,
): Promise<{ commit: string; tree: string }> {
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
			const sha = await writeNode(child)
			entries.push({ mode: treeEntryMode({ dir: true }), name, sha })
		}
		for (const f of n.files) {
			const sha = await writeGitObject(gitDir, 'blob', f.bytes)
			const name = f.path.split('/').pop() ?? f.path
			entries.push({
				mode: treeEntryMode({ exec: f.exec, symlink: f.symlink }),
				name,
				sha,
			})
		}
		const tree = encodeTree(entries)
		return writeGitObject(gitDir, 'tree', tree)
	}

	const tree = await writeNode(root)
	const commit = gitHash('commit', commitBytes)
	await writeGitObject(gitDir, 'commit', commitBytes)
	return { commit, tree }
}
