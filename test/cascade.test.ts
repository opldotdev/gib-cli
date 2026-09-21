import { describe, expect, it } from 'bun:test'
import {
	loadPublishedRoot,
	Plan,
	planCommit,
	type Tree,
} from '../src/cascade.ts'
import { packContent } from '../src/chain.ts'
import { DIR_CONTENT_TYPE, dirDecode, dirNameString } from '../src/ordfs/dir.ts'
import { PATCH_CONTENT_TYPE } from '../src/ordfs/patch.ts'
import { dryPublish, overlayStore } from '../src/preview.ts'
import { collectTree } from '../src/tree.ts'
import { memStore } from './helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const file = (path: string, body: string) => ({
	path,
	bytes: enc(body),
	contentType: 'text/plain',
})

/** Plan one commit, publish it into a scratch store, and read it back. */
async function publish(
	files: Array<{ path: string; bytes: Uint8Array; contentType: string }>,
	prev?: { tree: Tree; store: ReturnType<typeof memStore> },
) {
	const store = prev?.store ?? overlayStore(memStore())
	const plan = new Plan()
	const commit = await planCommit({ files, prev: prev?.tree, plan })
	const packed = await packContent({ plan, store, publish: dryPublish })
	const root = packed.outpoints.get(commit.rootId)
	if (!root) throw new Error('no root')
	return { store, root, plan, packed, tree: commit.tree }
}

describe('planCommit', () => {
	it('publishes leaves then the directories that name them', async () => {
		const plan = new Plan()
		const r = await planCommit({
			files: [file('README.md', 'hi'), file('src/a.ts', 'a')],
			plan,
		})
		const root = plan.nodes[r.rootId]
		expect(root.kind).toBe('dir')
		if (root.kind !== 'dir') throw new Error('not a dir')
		expect(root.entries.map((e) => e.name)).toEqual(['README.md', 'src'])
		// Every reference points at a node planned before it.
		for (const [id, node] of plan.nodes.entries()) {
			if (node.kind !== 'dir') continue
			for (const e of node.entries) {
				if (e.ref.kind === 'node') expect(e.ref.id).toBeLessThan(id)
			}
		}
	})

	it('cites an unchanged file instead of patching it', async () => {
		const first = await publish([file('f', 'same')])
		const second = await publish(
			[file('f', 'same'), file('g', 'new')],
			{ tree: await loadTree(first), store: first.store },
		)
		const root = dirDecode(
			(await read(second.store, second.root)).bytes,
		)
		const f = root.entries.find((e) => dirNameString(e.name) === 'f')
		expect(f?.ref.kind).toBe('outpoint')
		const files = await collectTree(second.store, second.root)
		expect(files.map((x) => x.path).sort()).toEqual(['f', 'g'])
	})

	it('patches a changed file against its published bytes', async () => {
		const first = await publish([file('f', 'one two three')])
		const plan = new Plan()
		await planCommit({
			files: [file('f', 'one two four')],
			prev: await loadTree(first),
			plan,
		})
		expect(
			plan.nodes.filter(
				(n) => n.kind === 'data' && n.contentType === PATCH_CONTENT_TYPE,
			),
		).toHaveLength(1)
	})

	it('cites an untouched subdirectory and rebuilds one a deletion emptied', async () => {
		const first = await publish([file('a/x', 'x1'), file('b/y', 'y1')])
		const second = await publish([file('a/x', 'x2'), file('b/y', 'y1')], {
			tree: await loadTree(first),
			store: first.store,
		})
		const root = dirDecode((await read(second.store, second.root)).bytes)
		expect(root.entries.map((e) => dirNameString(e.name))).toEqual(['a', 'b'])
		expect(root.entries.find((e) => dirNameString(e.name) === 'b')?.ref.kind).toBe(
			'outpoint',
		)

		const third = await publish([file('a/x', 'x2')], {
			tree: await loadTree(second),
			store: second.store,
		})
		expect(
			(await collectTree(third.store, third.root)).map((f) => f.path),
		).toEqual(['a/x'])
	})

	it('cannot patch against bytes that have no txid yet', async () => {
		const plan = new Plan()
		const first = await planCommit({ files: [file('f', 'v1')], plan })
		await planCommit({
			files: [file('f', 'v2 with more words')],
			prev: first.tree,
			plan,
		})
		expect(
			plan.nodes.filter(
				(n) => n.kind === 'data' && n.contentType === PATCH_CONTENT_TYPE,
			),
		).toHaveLength(0)
	})
})

async function read(store: ReturnType<typeof memStore>, op: { txid: string; vout: number }) {
	const { resolveOutpoint } = await import('../src/resolver.ts')
	const node = await resolveOutpoint(store, op)
	expect(node.contentType).toBe(DIR_CONTENT_TYPE)
	return node
}

/** The published tree as the next commit sees it, through the real reader. */
async function loadTree(published: {
	store: ReturnType<typeof memStore>
	root: { txid: string; vout: number }
}): Promise<Tree> {
	const files = await collectTree(published.store, published.root)
	const tree: Tree = { files: new Map(), dirs: new Map() }
	for (const f of files) {
		tree.files.set(f.path, {
			bytes: f.bytes,
			ref: { kind: 'outpoint', txid: f.outpoint.txid, vout: f.outpoint.vout },
			exec: f.exec,
			symlink: f.symlink,
			outpoint: f.outpoint,
		})
	}
	const { collectSnapshot } = await import('../src/tree.ts')
	for (const [path, op] of (await collectSnapshot(published.store, published.root)).dirs) {
		if (!path) continue
		tree.dirs.set(path, { kind: 'outpoint', txid: op.txid, vout: op.vout })
	}
	return tree
}
