import { describe, expect, it } from 'bun:test'
import {
	formatGibUrl,
	hostBaseUrl,
	parseGibUrl,
	parseIdentity,
} from '../src/remote/url.ts'

const txid = 'a'.repeat(64)
const origin = `${txid}_3`

describe('gib:// URLs', () => {
	it('parses a local-only URL', () => {
		expect(parseGibUrl(`gib://${origin}`)).toEqual({ host: '', origin })
		expect(parseGibUrl(`gib://${txid}.3`)).toEqual({ host: '', origin })
	})

	it('parses a peer URL and normalises the repository origin', () => {
		expect(parseGibUrl(`gib://gibhub.net/${txid.toUpperCase()}_3/`)).toEqual({
			host: 'gibhub.net',
			origin,
		})
	})

	it('round-trips through formatGibUrl', () => {
		for (const u of [`gib://${origin}`, `gib://gibhub.net/${origin}`]) {
			expect(formatGibUrl(parseGibUrl(u))).toBe(u)
		}
	})

	it('rejects junk, missing origins and identities in the host', () => {
		const id = `02${'b'.repeat(64)}`
		expect(() => parseGibUrl('https://gibhub.net/x')).toThrow(/not a gib/)
		expect(() => parseGibUrl('gib://gibhub.net/nope')).toThrow(
			/repository origin/,
		)
		expect(() => parseGibUrl(`gib://${id}/${origin}`)).toThrow(/identity/)
		expect(() => parseGibUrl(`gib://a/b/${origin}`)).toThrow(/gib URLs are/)
	})

	it('reads identities', () => {
		expect(parseIdentity(`03${'C'.repeat(64)}`)).toBe(`03${'c'.repeat(64)}`)
		expect(parseIdentity('04' + 'c'.repeat(64))).toBeUndefined()
		expect(parseIdentity('abc')).toBeUndefined()
	})

	it('uses http for loopback hosts only', () => {
		expect(hostBaseUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
		expect(hostBaseUrl('localhost')).toBe('http://localhost')
		expect(hostBaseUrl('gibhub.net')).toBe('https://gibhub.net')
	})
})
