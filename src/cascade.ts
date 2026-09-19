import { DIR_CONTENT_TYPE, dirEncode, dirName, type DirEntry } from './ordfs/dir.ts'
import { PATCH_CONTENT_TYPE, patchFromContent } from './ordfs/patch.ts'
import type { Outpoint } from './outpoint.ts'
import { collectSnapshot, type FileEntry } from './tree.ts'
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

export type CommitPlan = {
	outputs: PlannedOutput[]
	rootIndex: number
}

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

type DirRef =
	| { kind: 'same-tx'; vout: number }
	| { kind: 'outpoint'; txid: string; vout: number }

export async function planCommit(opts: {
	files: IncomingFile[]
	prevRoot?: Outpoint
	store?: TxStore
}): Promise<CommitPlan> {
	const old = new Map<string, FileEntry>()
	const oldDirs = new Map<string, Outpoint>()
	if (opts.prevRoot && opts.store) {
		const snap = await collectSnapshot(opts.store, opts.prevRoot)
		for (const f of snap.files) old.set(f.path, f)
		for (const [p, op] of snap.dirs) oldDirs.set(p, op)
	}

	const outputs: PlannedOutput[] = []
	const fileVout = new Map<string, DirRef>()
	const touchedDirs = new Set<string>([''])

	for (const f of opts.files) {
		const prev = old.get(f.path)
		if (prev && bytesEqual(prev.bytes, f.bytes)) {
			fileVout.set(f.path, {
				kind: 'outpoint',
				txid: prev.outpoint.txid,
				vout: prev.outpoint.vout,
			})
			continue
		}
		let dir = parentDir(f.path)
		while (true) {
			touchedDirs.add(dir)
			if (!dir) break
			dir = parentDir(dir)
		}
		if (prev) {
			const bytes = await patchFromContent({
				base: prev.outpoint,
				source: prev.bytes,
				target: f.bytes,
			})
			fileVout.set(f.path, { kind: 'same-tx', vout: outputs.length })
			outputs.push({ contentType: PATCH_CONTENT_TYPE, bytes, path: f.path })
		} else {
			fileVout.set(f.path, { kind: 'same-tx', vout: outputs.length })
			outputs.push({
				contentType: f.contentType ?? 'application/octet-stream',
				bytes: f.bytes,
				path: f.path,
			})
		}
	}

	const dirs = new Set<string>([''])
	for (const f of opts.files) {
		let d = parentDir(f.path)
		while (true) {
			dirs.add(d)
			if (!d) break
			d = parentDir(d)
		}
	}

	const children = new Map<string, Set<string>>()
	for (const d of dirs) {
		if (!d) continue
		const p = parentDir(d)
		if (!children.has(p)) children.set(p, new Set())
		children.get(p)!.add(d)
	}
	for (const f of opts.files) {
		const p = parentDir(f.path)
		if (!children.has(p)) children.set(p, new Set())
		children.get(p)!.add(f.path)
	}

	const sortedDirs = [...dirs].sort(
		(a, b) => b.split('/').filter(Boolean).length - a.split('/').filter(Boolean).length,
	)
	const dirVout = new Map<string, number>()
	const dirCite = new Map<string, Outpoint>()

	for (const d of sortedDirs) {
		if (!touchedDirs.has(d) && d !== '') {
			const prev = oldDirs.get(d)
			if (prev) dirCite.set(d, prev)
			continue
		}
		const names = [...(children.get(d) ?? [])].sort()
		const entries: DirEntry[] = []
		for (const name of names) {
			const base = basename(name)
			if (dirs.has(name)) {
				const v = dirVout.get(name)
				if (v !== undefined) {
					entries.push({
						name: dirName(base),
						isDir: true,
						ref: { kind: 'same-tx', vout: v },
					})
					continue
				}
				const cited = dirCite.get(name)
				if (cited) {
					entries.push({
						name: dirName(base),
						isDir: true,
						ref: { kind: 'outpoint', txid: cited.txid, vout: cited.vout },
					})
				}
				continue
			}
			const ref = fileVout.get(name)
			if (!ref) continue
			const file = opts.files.find((x) => x.path === name)
			entries.push({
				name: dirName(base),
				isDir: false,
				exec: file?.exec,
				symlink: file?.symlink,
				ref:
					ref.kind === 'same-tx'
						? { kind: 'same-tx', vout: ref.vout }
						: { kind: 'outpoint', txid: ref.txid, vout: ref.vout },
			})
		}
		dirVout.set(d, outputs.length)
		outputs.push({
			contentType: DIR_CONTENT_TYPE,
			bytes: dirEncode({ version: 1, entries }),
			path: d || '/',
		})
	}

	const rootIndex = dirVout.get('')
	if (rootIndex === undefined) throw new Error('cascade: missing root dir')
	return { outputs, rootIndex }
}
