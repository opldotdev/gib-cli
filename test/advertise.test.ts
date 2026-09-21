import { describe, expect, it } from 'bun:test'
import {
	advertise,
	chooseHead,
	refName,
	splitRef,
} from '../src/remote/advertise.ts'
import { emptyRepoState, recordHead, type RepoState } from '../src/refs.ts'

const me = `02${'1'.repeat(64)}`
const them = `03${'2'.repeat(64)}`
const origin = `${'a'.repeat(64)}_0`

function state(): RepoState {
	const s = emptyRepoState(origin)
	// The genesis head is the one whose root is the repository origin.
	recordHead(s, {
		identity: them,
		branch: 'trunk',
		head: `${'b'.repeat(64)}_0`,
		sha: 'a'.repeat(40),
		root: origin,
	})
	recordHead(s, {
		identity: me,
		branch: 'trunk',
		head: `${'c'.repeat(64)}_0`,
		sha: 'b'.repeat(40),
		root: `${'c'.repeat(64)}_1`,
	})
	recordHead(s, {
		identity: me,
		branch: 'feature',
		head: `${'d'.repeat(64)}_0`,
		sha: 'c'.repeat(40),
		root: `${'d'.repeat(64)}_1`,
	})
	return s
}

describe('ref naming', () => {
	it('names the wallet its own branches bare and everyone else attributed', () => {
		expect(refName(me, 'trunk', me)).toBe('refs/heads/trunk')
		expect(refName(them, 'trunk', me)).toBe(`refs/heads/@${them}/trunk`)
		// With no identity known, nothing is bare.
		expect(refName(me, 'trunk', '')).toBe(`refs/heads/@${me}/trunk`)
	})

	it('maps a ref back to its publisher and branch', () => {
		expect(splitRef('refs/heads/trunk', me)).toEqual({
			publisher: me,
			branch: 'trunk',
		})
		expect(splitRef(`refs/heads/@${them}/feat/x`, me)).toEqual({
			publisher: them,
			branch: 'feat/x',
		})
		expect(() => splitRef('refs/tags/v1', me)).toThrow(/gib serves/)
		expect(() => splitRef('refs/heads/@nope/x', me)).toThrow(/identity/)
	})

	it('advertises every publisher, sorted, from the store', () => {
		expect(advertise(state(), me).map((r) => r.name)).toEqual([
			`refs/heads/@${them}/trunk`,
			'refs/heads/feature',
			'refs/heads/trunk',
		])
		expect(advertise(state(), '').map((r) => r.name).sort()).toEqual([
			`refs/heads/@${me}/feature`,
			`refs/heads/@${me}/trunk`,
			`refs/heads/@${them}/trunk`,
		])
	})

	it('points HEAD at the genesis head branch, preferring our own ref', () => {
		const s = state()
		expect(s.genesis).toEqual({ identity: them, branch: 'trunk', head: `${'b'.repeat(64)}_0` })
		expect(chooseHead(advertise(s, me), s, me)).toBe('refs/heads/trunk')
		// A reader with no wallet gets the owner's, not a stranger's.
		expect(chooseHead(advertise(s, ''), s, '')).toBe(`refs/heads/@${them}/trunk`)
		// Nothing to advertise, nothing to point at.
		expect(chooseHead([], s, me)).toBeUndefined()
	})

	it('falls back to main, then master, then the first ref', () => {
		const s = emptyRepoState(origin)
		recordHead(s, {
			identity: me,
			branch: 'dev',
			head: `${'e'.repeat(64)}_0`,
			sha: 'd'.repeat(40),
			root: `${'e'.repeat(64)}_1`,
		})
		expect(chooseHead(advertise(s, me), s, me)).toBe('refs/heads/dev')
		recordHead(s, {
			identity: me,
			branch: 'main',
			head: `${'f'.repeat(64)}_0`,
			sha: 'e'.repeat(40),
			root: `${'f'.repeat(64)}_1`,
		})
		expect(chooseHead(advertise(s, me), s, me)).toBe('refs/heads/main')
	})
})
