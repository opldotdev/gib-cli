import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPending, loadPending, savePending } from '../src/pending.ts'

describe('pending cache', () => {
	it('saves and clears', async () => {
		const home = await mkdtemp(join(tmpdir(), 'gib-pend-'))
		try {
			await savePending(
				'abc',
				[{ txid: 'aa'.repeat(32), bytes: new Uint8Array([1, 2]), beef: [3, 4] }],
				home,
			)
			const got = await loadPending('abc', home)
			expect(got?.[0].txid).toBe('aa'.repeat(32))
			expect(got?.[0].bytes).toEqual(new Uint8Array([1, 2]))
			expect(got?.[0].beef).toEqual([3, 4])
			await clearPending('abc', home)
			expect(await loadPending('abc', home)).toBeUndefined()
		} finally {
			await rm(home, { recursive: true, force: true })
		}
	})
})
