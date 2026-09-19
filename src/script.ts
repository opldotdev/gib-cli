import { B, Encoding, Inscription } from '@1sat/templates'
import type { Script } from '@bsv/sdk'

export const GIT_COMMIT_TYPE = 'application/x-git-commit'

export function bLockingScript(contentType: string, body: Uint8Array) {
	return B.lock(body, contentType, Encoding.Binary)
}

export function appendOrdEnvelope(
	prefix: Script,
	contentType: string,
	body: Uint8Array,
) {
	return Inscription.create(body, contentType, { scriptPrefix: prefix }).lock()
}
