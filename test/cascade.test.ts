import { describe, expect, it } from 'bun:test'
import { planCommit } from '../src/cascade.ts'
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
			prevRoot: { txid, vout: genesis.rootIndex },
			store,
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
			prevRoot: { txid, vout: genesis.rootIndex },
			store,
		})
		const root = dirDecode(next.outputs[next.rootIndex].bytes)
		expect(root.entries.map((e) => dirNameString(e.name)).sort()).toEqual(['a', 'b'])
		const b = root.entries.find((e) => dirNameString(e.name) === 'b')
		expect(b?.ref.kind).toBe('outpoint')
	})
})
