import { describe, expect, it } from 'bun:test'
import { OP } from '@bsv/sdk'
import { payloadFromScript } from '../src/content.ts'
import { bLockingScript, isProvablyUnspendable } from '../src/script.ts'

describe('content output scripts', () => {
	it('are OP_FALSE OP_RETURN (provably unspendable, minable at zero sats)', () => {
		const s = bLockingScript('text/plain', new TextEncoder().encode('hi'))
		const b = s.toBinary()
		expect(b[0]).toBe(OP.OP_FALSE)
		expect(b[1]).toBe(OP.OP_RETURN)
		expect(isProvablyUnspendable(s)).toBe(true)
		const p = payloadFromScript(s)
		expect(p?.contentType).toBe('text/plain')
		expect(new TextDecoder().decode(p?.bytes)).toBe('hi')
	})
})
