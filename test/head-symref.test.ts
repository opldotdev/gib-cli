import { describe, expect, it } from 'bun:test'
import { chooseHead } from '../src/remote/helper.ts'
import { memStore } from './helpers.ts'

const origin = 'o_0'
const refs = [{ name: 'refs/heads/dev' }, { name: 'refs/heads/main' }]

describe('HEAD symref from .gib', () => {
	it('uses .gib defaultBranch when that branch exists', async () => {
		expect(await chooseHead(memStore(), origin, refs, async () => 'dev')).toBe('refs/heads/dev')
	})
	it('falls back to main, then first ref, when .gib is missing or points nowhere', async () => {
		expect(await chooseHead(memStore(), origin, refs, async () => 'gone')).toBe('refs/heads/main')
		expect(await chooseHead(memStore(), origin, refs, async () => undefined)).toBe('refs/heads/main')
		expect(await chooseHead(memStore(), origin, [refs[0]], async () => undefined)).toBe('refs/heads/dev')
		expect(await chooseHead(memStore(), origin, [], async () => 'main')).toBeUndefined()
	})
})
