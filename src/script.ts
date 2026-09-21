import { buildDataScript } from '@1sat/actions'
import { OP, type Script } from '@bsv/sdk'

/** Content type of a git commit object published in a tree's `.git`. */
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
