import { B, Encoding, Inscription } from '@1sat/templates'
import { OP, Script } from '@bsv/sdk'

export const GIT_COMMIT_TYPE = 'application/x-git-commit'

/**
 * A standalone zero-sat data output must be provably unspendable
 * (OP_FALSE OP_RETURN) or miners treat it as dust and never mine it. The
 * B template emits a bare OP_RETURN fragment (so it can also trail a
 * spendable script); standalone callers own the prefix.
 */
export function bLockingScript(contentType: string, body: Uint8Array) {
	return new Script([
		{ op: OP.OP_FALSE },
		...B.lock(body, contentType, Encoding.Binary).chunks,
	])
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
