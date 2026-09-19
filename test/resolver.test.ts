import { describe, expect, it } from 'bun:test'
import { DIR_CONTENT_TYPE, dirEncode, dirName } from '../src/ordfs/dir.ts'
import { PATCH_CONTENT_TYPE, patchFromContent } from '../src/ordfs/patch.ts'
import { resolveOutpoint, resolvePath } from '../src/resolver.ts'
import { bScript, memStore, ordScript, txWithOutputs } from './helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('resolver', () => {
	it('resolves a B file payload', async () => {
		const body = enc('hello')
		const { txid, bytes } = txWithOutputs([bScript('text/plain', body)])
		const store = memStore()
		await store.put(txid, bytes)
		const r = await resolveOutpoint(store, { txid, vout: 0 })
		expect(r.contentType).toBe('text/plain')
		expect(r.bytes).toEqual(body)
	})

	it('walks ordfs/dir same-tx children and default entry', async () => {
		const readme = enc('# hi')
		const manifest = dirEncode({
			version: 1,
			entries: [
				{
					name: dirName('index.html'),
					isDir: false,
					ref: { kind: 'same-tx', vout: 0 },
				},
			],
		})
		const { txid, bytes } = txWithOutputs([
			ordScript('text/html', readme),
			ordScript(DIR_CONTENT_TYPE, manifest),
		])
		const store = memStore()
		await store.put(txid, bytes)
		const def = await resolvePath(store, { txid, vout: 1 }, '')
		expect(def.bytes).toEqual(readme)
		const named = await resolvePath(store, { txid, vout: 1 }, 'index.html')
		expect(named.bytes).toEqual(readme)
	})

	it('applies ordfs/patch against a base', async () => {
		const source = enc('hello world, this is the base file')
		const target = enc('hello world, this is the base file PLUS')
		const baseTx = txWithOutputs([ordScript('text/plain', source)])
		const patch = await patchFromContent({
			base: { txid: baseTx.txid, vout: 0 },
			source,
			target,
		})
		const patchTx = txWithOutputs([ordScript(PATCH_CONTENT_TYPE, patch)])
		const store = memStore()
		await store.put(baseTx.txid, baseTx.bytes)
		await store.put(patchTx.txid, patchTx.bytes)
		const r = await resolveOutpoint(store, { txid: patchTx.txid, vout: 0 })
		expect(r.contentType).toBe('text/plain')
		expect(r.bytes).toEqual(target)
	})
})
