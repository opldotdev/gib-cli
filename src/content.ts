/**
 * Content payloads: the bytes and media type of an on-chain output, whether
 * it is an ordinal inscription (ord envelope) or a B data output. Decoding
 * is the SDK's; gib only names what it needs from the result.
 */
import { B, Inscription } from '@1sat/templates'
import type { LockingScript, Script } from '@bsv/sdk'

export type Payload = {
	contentType: string
	bytes: Uint8Array
}

export function payloadFromScript(
	script: LockingScript | Script,
): Payload | undefined {
	const insc = Inscription.decode(script)
	if (insc) {
		return { contentType: insc.file.type, bytes: insc.file.content }
	}
	const b = B.decode(script)
	if (b) {
		return { contentType: String(b.mediaType), bytes: new Uint8Array(b.data) }
	}
	return undefined
}
