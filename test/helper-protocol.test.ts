import { describe, expect, it } from 'bun:test'
import { originFromUrl, runHelper } from '../src/remote/helper.ts'
import { memStore } from './helpers.ts'

describe('git-remote-gib protocol', () => {
	it('parses gib:// origin', () => {
		expect(originFromUrl('gib://aa'.repeat(1) + '_0')).toContain('_0')
		expect(originFromUrl('gib://abc_1/')).toBe('abc_1')
	})

	it('advertises capabilities', async () => {
		const lines = ['capabilities', 'list', '']
		let i = 0
		const out: string[] = []
		await runHelper({
			url: 'gib://aa'.repeat(32).slice(0, 6 + 64) + '_0',
			store: memStore(),
			gitDir: '/tmp',
			io: {
				async read() {
					return i < lines.length ? lines[i++] : null
				},
				write(s) {
					out.push(s)
				},
			},
		})
		expect(out.join('')).toContain('fetch')
		expect(out.join('')).toContain('push')
	})
})
