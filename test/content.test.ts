import { describe, expect, it } from 'bun:test'
import { payloadFromScript } from '../src/content.ts'
import { bScript, ordScript } from './helpers.ts'

describe('payloadFromScript', () => {
	it('decodes an empty B body', () => {
		const p = payloadFromScript(bScript('text/plain', new Uint8Array(0)))
		expect(p?.contentType).toBe('text/plain')
		expect(p?.bytes).toEqual(new Uint8Array(0))
	})

	it('decodes an empty ord body', () => {
		const p = payloadFromScript(ordScript('text/plain', new Uint8Array(0)))
		expect(p?.contentType).toBe('text/plain')
		expect(p?.bytes).toEqual(new Uint8Array(0))
	})
})
