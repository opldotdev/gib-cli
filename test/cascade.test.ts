import { describe, expect, it } from 'bun:test'
import { planCommit, treeFromRoot } from '../src/cascade.ts'
import { DIR_CONTENT_TYPE, dirDecode, dirNameString } from '../src/ordfs/dir.ts'
import { PATCH_CONTENT_TYPE } from '../src/ordfs/patch.ts'
import { bScript, memStore, txWithOutputs } from './helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('planCommit', () => {
	it('genesis: leaves then root dir', async () => {
		const plan = await planCommit({
			files: [
				{ path: 'README.md', bytes: enc('hi'), contentType: 'text/markdown' },
				{ path: 'src/a.ts', bytes: enc('a'), contentType: 'text/plain' },
			],
		})
		expect(plan.outputs[plan.rootIndex].contentType).toBe(DIR_CONTENT_TYPE)
		const root = dirDecode(plan.outputs[plan.rootIndex].bytes)
		expect(root.entries.map((e) => dirNameString(e.name))).toEqual(['README.md', 'src'])
		const files = plan.outputs.filter((o) => o.contentType !== DIR_CONTENT_TYPE)
		expect(files).toHaveLength(2)
	})

	it('unchanged file is cited, not patched', async () => {
		const body = enc('same')
		const genesis = await planCommit({
			files: [{ path: 'f', bytes: body, contentType: 'text/plain' }],
		})
		const scripts = genesis.outputs.map((o) => bScript(o.contentType, o.bytes))
		const { txid, bytes } = txWithOutputs(scripts)
		const store = memStore()
		await store.put(txid, bytes)
		const next = await planCommit({
			files: [
				{ path: 'f', bytes: body, contentType: 'text/plain' },
				{ path: 'g', bytes: enc('new'), contentType: 'text/plain' },
			],
			prev: await treeFromRoot(store, { txid, vout: genesis.rootIndex }),
		})
		const patches = next.outputs.filter((o) => o.contentType === PATCH_CONTENT_TYPE)
		expect(patches).toHaveLength(0)
		const root = dirDecode(next.outputs[next.rootIndex].bytes)
		const f = root.entries.find((e) => dirNameString(e.name) === 'f')
		expect(f?.ref.kind).toBe('outpoint')
	})

	it('cites an untouched subdirectory instead of dropping it', async () => {
		const genesis = await planCommit({
			files: [
				{ path: 'a/x', bytes: enc('x1'), contentType: 'text/plain' },
				{ path: 'b/y', bytes: enc('y1'), contentType: 'text/plain' },
			],
		})
		const scripts = genesis.outputs.map((o) => bScript(o.contentType, o.bytes))
		const { txid, bytes } = txWithOutputs(scripts)
		const store = memStore()
		await store.put(txid, bytes)
		const next = await planCommit({
			files: [
				{ path: 'a/x', bytes: enc('x2'), contentType: 'text/plain' },
				{ path: 'b/y', bytes: enc('y1'), contentType: 'text/plain' },
			],
			prev: await treeFromRoot(store, { txid, vout: genesis.rootIndex }),
		})
		const root = dirDecode(next.outputs[next.rootIndex].bytes)
		expect(root.entries.map((e) => dirNameString(e.name)).sort()).toEqual(['a', 'b'])
		const b = root.entries.find((e) => dirNameString(e.name) === 'b')
		expect(b?.ref.kind).toBe('outpoint')
	})

	it('patches a changed file against its published bytes', async () => {
		const genesis = await planCommit({
			files: [{ path: 'f', bytes: enc('one two three'), contentType: 'text/plain' }],
		})
		const { txid, bytes } = txWithOutputs(
			genesis.outputs.map((o) => bScript(o.contentType, o.bytes)),
		)
		const store = memStore()
		await store.put(txid, bytes)
		const next = await planCommit({
			files: [{ path: 'f', bytes: enc('one two four'), contentType: 'text/plain' }],
			prev: await treeFromRoot(store, { txid, vout: genesis.rootIndex }),
		})
		expect(
			next.outputs.filter((o) => o.contentType === PATCH_CONTENT_TYPE),
		).toHaveLength(1)
	})

	it('rebuilds a directory a deletion emptied out of the tree', async () => {
		const genesis = await planCommit({
			files: [
				{ path: 'keep', bytes: enc('k'), contentType: 'text/plain' },
				{ path: 'a/gone', bytes: enc('g'), contentType: 'text/plain' },
			],
		})
		const { txid, bytes } = txWithOutputs(
			genesis.outputs.map((o) => bScript(o.contentType, o.bytes)),
		)
		const store = memStore()
		await store.put(txid, bytes)
		const next = await planCommit({
			files: [{ path: 'keep', bytes: enc('k'), contentType: 'text/plain' }],
			prev: await treeFromRoot(store, { txid, vout: genesis.rootIndex }),
		})
		const root = dirDecode(next.outputs[next.rootIndex].bytes)
		expect(root.entries.map((e) => dirNameString(e.name))).toEqual(['keep'])
	})

	it('appends to a transaction that already has outputs and chains trees', async () => {
		const first = await planCommit({
			files: [{ path: 'f', bytes: enc('v1'), contentType: 'text/plain' }],
			baseVout: 3,
		})
		expect(first.rootIndex).toBe(3 + first.outputs.length - 1)
		const second = await planCommit({
			files: [
				{ path: 'f', bytes: enc('v1'), contentType: 'text/plain' },
				{ path: 'g', bytes: enc('v2'), contentType: 'text/plain' },
			],
			prev: first.tree,
			baseVout: 3 + first.outputs.length,
		})
		// f is unchanged, so it is cited in place — inside the same tx.
		const root = dirDecode(second.outputs[second.rootIndex - 3 - first.outputs.length].bytes)
		const f = root.entries.find((e) => dirNameString(e.name) === 'f')
		expect(f?.ref).toEqual({ kind: 'same-tx', vout: 3 })
		// Nothing can be patched against bytes that have no txid yet.
		expect(
			second.outputs.filter((o) => o.contentType === PATCH_CONTENT_TYPE),
		).toHaveLength(0)
	})
})
