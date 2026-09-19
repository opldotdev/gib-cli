import { describe, expect, it } from 'bun:test'
import { chooseHead } from '../src/remote/helper.ts'
import { memStore } from './helpers.ts'

const refs = [
	{ name: 'refs/heads/dev', root: 'a_0' },
	{ name: 'refs/heads/main', root: 'b_0' },
]

describe('HEAD symref from .gib', () => {
	it('uses .gib defaultBranch when that branch exists', async () => {
		expect(await chooseHead(memStore(), refs, async () => 'dev')).toBe('refs/heads/dev')
	})
	it('falls back to main, then first ref, when .gib is missing or points nowhere', async () => {
		expect(await chooseHead(memStore(), refs, async () => 'gone')).toBe('refs/heads/main')
		expect(await chooseHead(memStore(), refs, async () => undefined)).toBe('refs/heads/main')
		expect(await chooseHead(memStore(), [refs[0]], async () => undefined)).toBe('refs/heads/dev')
		expect(await chooseHead(memStore(), [], async () => 'main')).toBeUndefined()
	})
})
