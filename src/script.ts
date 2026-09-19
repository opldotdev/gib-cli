import { buildDataScript } from '@1sat/actions'
import { Inscription } from '@1sat/templates'
import { OP, type Script } from '@bsv/sdk'

export const GIT_COMMIT_TYPE = 'application/x-git-commit'

/** Standalone zero-sat data output (OP_FALSE OP_RETURN | B), built by the SDK. */
export function bLockingScript(contentType: string, body: Uint8Array) {
	return buildDataScript(body, contentType)
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
