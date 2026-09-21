import { describe, expect, it } from 'bun:test'
import { Plan, planCommit } from '../src/cascade.ts'
import { MAX_CONTENT_OUTPUTS, packContent } from '../src/chain.ts'
import { dirDecode } from '../src/ordfs/dir.ts'
import { dryPublish, overlayStore } from '../src/preview.ts'
import type { PlannedOutput, PublishedTx } from '../src/publish.ts'
import { resolveOutpoint } from '../src/resolver.ts'
import { collectTree } from '../src/tree.ts'
import { memStore } from './helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const file = (path: string, body: string) => ({
	path,
	bytes: enc(body),
	contentType: 'text/plain',
})

describe('packing a plan into transactions', () => {
	it('keeps a whole tree in one transaction when it fits', async () => {
		const plan = new Plan()
		const r = await planCommit({
			files: [file('a.txt', 'a'), file('dir/b.txt', 'b')],
			plan,
		})
		const store = overlayStore(memStore())
		const packed = await packContent({ plan, store, publish: dryPublish })
		expect(packed.txs).toHaveLength(1)
		const root = packed.outpoints.get(r.rootId)
		if (!root) throw new Error('no root')
		// Inside one transaction every reference is a single vout byte.
		const manifest = dirDecode((await resolveOutpoint(store, root)).bytes)
		expect(manifest.entries.every((e) => e.ref.kind === 'same-tx')).toBe(true)
		expect(
			(await collectTree(store, root)).map((f) => f.path).sort(),
		).toEqual(['a.txt', 'dir/b.txt'])
	})

	it('spills into more transactions and cites what came before', async () => {
		const plan = new Plan()
		const files = Array.from({ length: 12 }, (_, i) =>
			file(`d${i % 3}/f${i}.txt`, `body ${i}`),
		)
		const r = await planCommit({ files, plan })
		expect(plan.size).toBeGreaterThan(4)
		const store = overlayStore(memStore())
		const packed = await packContent({
			plan,
			store,
			publish: dryPublish,
			maxOutputs: 4,
		})
		expect(packed.txs.length).toBeGreaterThan(1)
		const root = packed.outpoints.get(r.rootId)
		if (!root) throw new Error('no root')
		// The files landed in earlier transactions than the directories
		// that name them, so those references are full outpoints.
		const manifest = dirDecode((await resolveOutpoint(store, root)).bytes)
		const sub = manifest.entries[0]
		if (sub.ref.kind !== 'same-tx') throw new Error('expected a sibling dir')
		const subdir = dirDecode(
			(await resolveOutpoint(store, { txid: root.txid, vout: sub.ref.vout }))
				.bytes,
		)
		expect(subdir.entries.every((e) => e.ref.kind === 'outpoint')).toBe(true)
		expect(await collectTree(store, root)).toHaveLength(12)
	})

	it('never asks for a same-transaction vout a byte cannot hold', () => {
		expect(MAX_CONTENT_OUTPUTS).toBe(256)
	})

	it('refuses a publisher that hands back different outputs', async () => {
		const plan = new Plan()
		await planCommit({ files: [file('a.txt', 'a')], plan })
		const shuffling = async (outputs: PlannedOutput[]): Promise<PublishedTx> => {
			const tx = await dryPublish([...outputs].reverse())
			return tx
		}
		expect(
			packContent({
				plan,
				store: overlayStore(memStore()),
				publish: shuffling,
			}),
		).rejects.toThrow(/without the planned outputs in order/)
	})

	it('reuses a transaction an interrupted push already published', async () => {
		const plan = new Plan()
		await planCommit({ files: [file('a.txt', 'a')], plan })
		const store = overlayStore(memStore())
		const first = await packContent({ plan, store, publish: dryPublish })
		let published = 0
		const second = await packContent({
			plan,
			store,
			pending: first.txs,
			publish: async (o) => {
				published++
				return dryPublish(o)
			},
		})
		expect(published).toBe(0)
		expect(second.reused).toBe(1)
		expect(second.txs[0].txid).toBe(first.txs[0].txid)
	})
})
