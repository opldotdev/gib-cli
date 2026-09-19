import { B, BitCom, Encoding, Inscription } from '@1sat/templates'
import { OP, Script } from '@bsv/sdk'

export const GIT_COMMIT_TYPE = 'application/x-git-commit'

/**
 * A standalone zero-sat data output. BitCom is appended to a starting
 * script the caller chooses; for a zero-sat output that must be OP_FALSE so
 * the output is provably unspendable (post-Genesis), otherwise miners treat
 * it as dust and never mine it. B.lock() builds the protocol section; the
 * BitCom template carries the prefix.
 */
export function bLockingScript(contentType: string, body: Uint8Array) {
	const b = BitCom.decode(B.lock(body, contentType, Encoding.Binary))
	if (!b) throw new Error('B.lock produced an undecodable script')
	return new BitCom(b.protocols, [OP.OP_FALSE]).lock()
}

/** True when a zero-sat output is provably unspendable and therefore minable. */
export function isProvablyUnspendable(script: Script): boolean {
	const b = script.toBinary()
	return b.length >= 2 && b[0] === OP.OP_FALSE && b[1] === OP.OP_RETURN
}

export function appendOrdEnvelope(
	prefix: Script,
	contentType: string,
	body: Uint8Array,
) {
	return Inscription.create(body, contentType, { scriptPrefix: prefix }).lock()
}
