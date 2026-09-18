import { LockingScript, OP, Script, Utils } from '@bsv/sdk'
import { B_PREFIX } from './content.ts'

export function bLockingScript(contentType: string, body: Uint8Array): LockingScript {
	const s = new Script()
	s.writeOpCode(OP.OP_FALSE)
	s.writeOpCode(OP.OP_RETURN)
	s.writeBin(Utils.toArray(B_PREFIX, 'utf8'))
	s.writeBin(Array.from(body))
	s.writeBin(Utils.toArray(contentType, 'utf8'))
	s.writeBin(Utils.toArray('binary', 'utf8'))
	return LockingScript.fromBinary(s.toBinary())
}

export function appendOrdEnvelope(
	prefix: Script,
	contentType: string,
	body: Uint8Array,
): LockingScript {
	const s = new Script()
	for (const c of prefix.chunks) s.chunks.push(c)
	s.writeOpCode(OP.OP_FALSE)
	s.writeOpCode(OP.OP_IF)
	s.writeBin(Utils.toArray('ord', 'utf8'))
	s.writeOpCode(OP.OP_1)
	s.writeBin(Utils.toArray(contentType, 'utf8'))
	s.writeOpCode(OP.OP_0)
	s.writeBin(Array.from(body))
	s.writeOpCode(OP.OP_ENDIF)
	return LockingScript.fromBinary(s.toBinary())
}

export const GIT_COMMIT_TYPE = 'application/x-git-commit'
